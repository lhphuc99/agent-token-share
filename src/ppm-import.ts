import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createDecipheriv, scryptSync } from "node:crypto";
import type { Kind } from "./store";

export interface PpmAccount {
  id: string;
  label: string;
  kind: Kind;
  token: string;
  expiresAt?: number;
}

function getPpmDir(): string {
  return process.env.PPM_HOME || resolve(homedir(), ".ppm");
}

// PPM local format: `<iv hex>:<authTag hex>:<ciphertext hex>`, key from ~/.ppm/account.key
function ppmDecrypt(encoded: string, key: Buffer): string {
  const [ivHex, tagHex, ctHex] = encoded.split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([d.update(Buffer.from(ctHex, "hex")), d.final()]).toString("utf-8");
}

interface PpmExportEnvelope {
  version: 1;
  kdf: "scrypt";
  salt: string;       // hex, 32 bytes
  iv: string;         // hex, 12 bytes
  authTag: string;    // hex, 16 bytes
  ciphertext: string; // base64
}

interface PpmAccountRow {
  id: string;
  label?: string;
  email?: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

/** Decrypt a PPM account-export JSON blob → array of accounts ready to import */
export function decryptPPMExport(blob: string, password: string): PpmAccount[] {
  let envelope: PpmExportEnvelope;
  try {
    envelope = JSON.parse(blob.trim());
  } catch {
    throw new Error("Not a valid PPM backup (expected JSON).");
  }
  if (envelope.version !== 1 || envelope.kdf !== "scrypt") {
    throw new Error("Unsupported PPM backup version.");
  }
  const salt = Buffer.from(envelope.salt, "hex");
  const iv = Buffer.from(envelope.iv, "hex");
  const authTag = Buffer.from(envelope.authTag, "hex");
  const ct = Buffer.from(envelope.ciphertext, "base64");
  // PPM uses scrypt N=16384 r=8 p=1 (Node default params)
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(authTag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([d.update(ct), d.final()]).toString("utf-8");
  } catch {
    throw new Error("Wrong password or corrupted backup.");
  }
  const rows: PpmAccountRow[] = JSON.parse(plaintext);
  return rows
    .filter((r) => r.access_token)
    .map((r) => ({
      id: r.id,
      label: r.label || r.email || "PPM Claude",
      kind: "claude" as Kind,
      token: r.access_token,
      expiresAt: r.expires_at || undefined,
    }));
}

export function importFromPPM(): PpmAccount[] {
  const ppmDir = getPpmDir();
  const keyPath = resolve(ppmDir, "account.key");
  const dbPath = resolve(ppmDir, "ppm.db");

  if (!existsSync(keyPath)) throw new Error(`PPM key not found: ${keyPath}`);
  if (!existsSync(dbPath)) throw new Error(`PPM database not found: ${dbPath}`);

  const key = Buffer.from(readFileSync(keyPath, "utf-8").trim(), "hex");

  // PPM uses Bun + bun:sqlite — spawn a temporary Bun script to query the DB.
  // mkdtempSync gives an isolated directory so the script path is unguessable.
  const tmpDir = mkdtempSync(join(tmpdir(), "ppm-q-"));
  const tmpScript = join(tmpDir, "query.mjs");
  writeFileSync(tmpScript,
    `import { Database } from "bun:sqlite";\n` +
    `const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });\n` +
    `const claude = db.query("SELECT id, label, email, access_token, expires_at FROM accounts WHERE status != 'disabled'").all();\n` +
    `const codex = db.query("SELECT id, label, creds_enc FROM codex_accounts WHERE status != 'disabled'").all();\n` +
    `db.close();\n` +
    `console.log(JSON.stringify({ claude, codex }));\n`
  );

  let raw: { claude: any[]; codex: any[] };
  try {
    const out = execFileSync("bun", [tmpScript], { encoding: "utf-8", timeout: 8000 });
    raw = JSON.parse(out.trim());
  } catch (e) {
    throw new Error("Failed to read PPM database (is Bun installed?): " + String((e as Error).message ?? e));
  } finally {
    try { unlinkSync(tmpScript); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  }

  const accounts: PpmAccount[] = [];

  for (const row of raw.claude ?? []) {
    try {
      const token = ppmDecrypt(row.access_token, key);
      accounts.push({
        id: row.id,
        label: row.label || row.email || "PPM Claude",
        kind: "claude",
        token,
        expiresAt: row.expires_at || undefined,
      });
    } catch {}
  }

  for (const row of raw.codex ?? []) {
    try {
      const credsJson = ppmDecrypt(row.creds_enc, key);
      const creds = JSON.parse(credsJson) as { apiKey?: string; accessToken?: string };
      const token = creds.apiKey || creds.accessToken || "";
      if (token) {
        accounts.push({
          id: row.id,
          label: row.label || "PPM Codex",
          kind: "codex",
          token,
        });
      }
    } catch {}
  }

  return accounts;
}
