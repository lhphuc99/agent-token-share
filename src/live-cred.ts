import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface LiveCred {
  accessToken: string;
  expiresAt?: number;
}

export function parseClaudeCred(raw: string): LiveCred | null {
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    if (!o?.accessToken) return null;
    return { accessToken: o.accessToken, expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : undefined };
  } catch {
    return null;
  }
}

// Reads the token from the user's EXISTING Claude login — no login flow here.
// macOS: the Keychain item Claude Code wrote (one-time access prompt on first read).
// Linux/Windows: ~/.claude/.credentials.json (a plain file — no prompt).
export async function readClaudeCred(): Promise<LiveCred | null> {
  let raw: string | undefined;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await pexec("security", ["find-generic-password", "-w", "-s", "Claude Code-credentials"]);
      raw = stdout;
    } catch {
      raw = undefined;
    }
  } else {
    raw = await fs.promises.readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8").catch(() => undefined);
  }
  return raw ? parseClaudeCred(raw) : null;
}

// expiresAt may be epoch seconds or milliseconds; return minutes left, or null if unknown.
export function remainingMins(expiresAt?: number): number | null {
  if (!expiresAt) return null;
  const ms = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  return Math.max(0, Math.round((ms - Date.now()) / 60000));
}

// --- Codex ------------------------------------------------------------------
// Codex keeps credentials in a plain file $CODEX_HOME/auth.json (no keychain, any OS).

export interface CodexCred {
  authJson: string; // full auth.json text with refresh_token blanked
  expiresAt?: number;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// Decode a JWT's `exp` claim (epoch seconds) without verifying it.
export function jwtExp(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const seg = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(seg, "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

// Build a shareable auth.json: keep the short-lived access token, BLANK the refresh token.
// codex requires the refresh_token field to exist but accepts an empty string.
export function parseCodexAuth(raw: string): CodexCred | null {
  try {
    const d = JSON.parse(raw);
    if (!d?.tokens?.access_token) return null;
    const exp = jwtExp(d.tokens.access_token);
    d.tokens.refresh_token = "";
    return { authJson: JSON.stringify(d), expiresAt: exp };
  } catch {
    return null;
  }
}

export async function readCodexCred(): Promise<CodexCred | null> {
  const raw = await fs.promises.readFile(path.join(codexHome(), "auth.json"), "utf8").catch(() => undefined);
  return raw ? parseCodexAuth(raw) : null;
}
