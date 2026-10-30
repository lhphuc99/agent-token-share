import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Kind } from "./store";
import { writeCurrentToken, clearCurrentToken } from "./wrapper";
import { readClaudeCred, readCodexCred, codexHome } from "./live-cred";

export interface ExportPayload {
  kind: Kind;
  token: string;
  expiresAt?: number;
  label?: string;
}

export interface Provider {
  kind: Kind;
  name: string;
  // Owner side: snapshot the SHORT-LIVED token from the existing login (no login flow here).
  snapshot(): Promise<{ token: string; expiresAt?: number } | null>;
  validate(token: string): boolean;
  // Recipient side: make the NEXT session (CLI or extension) use this token.
  apply(ctx: vscode.ExtensionContext, token: string): Promise<void>;
  // Restore the user's own login.
  clear(ctx: vscode.ExtensionContext): Promise<void>;
  // Env for a terminal launched on this account, if the provider needs one.
  terminalEnv?(token: string): Record<string, string>;
}

export const claudeProvider: Provider = {
  kind: "claude",
  name: "Claude",
  async snapshot() {
    const c = await readClaudeCred();
    return c ? { token: c.accessToken, expiresAt: c.expiresAt } : null;
  },
  validate: (t) => t.startsWith("sk-ant-oat") || t.startsWith("sk-ant-api"),
  // The wrapper reads this file and injects CLAUDE_CODE_OAUTH_TOKEN on the next spawn.
  async apply(ctx, token) {
    await writeCurrentToken(ctx, token);
  },
  async clear(ctx) {
    await clearCurrentToken(ctx);
  },
  terminalEnv: (token) => ({ CLAUDE_CODE_OAUTH_TOKEN: token }),
};

const CODEX_BACKUP = "codex-own-auth.json.bak";

export const codexProvider: Provider = {
  kind: "codex",
  name: "Codex",
  async snapshot() {
    const c = await readCodexCred();
    return c ? { token: c.authJson, expiresAt: c.expiresAt } : null;
  },
  validate: (t) => {
    try {
      return !!JSON.parse(t)?.tokens?.access_token;
    } catch {
      return false;
    }
  },
  // Both the CLI and the Codex extension read $CODEX_HOME/auth.json (default ~/.codex),
  // so switching = swapping that file. The user's own login is backed up first.
  async apply(ctx, token) {
    const authPath = path.join(codexHome(), "auth.json");
    const backup = path.join(ctx.globalStorageUri.fsPath, CODEX_BACKUP);
    await fs.promises.mkdir(ctx.globalStorageUri.fsPath, { recursive: true });
    if (!fs.existsSync(backup) && fs.existsSync(authPath)) await fs.promises.copyFile(authPath, backup);
    await fs.promises.mkdir(codexHome(), { recursive: true });
    await fs.promises.writeFile(authPath, token, { mode: 0o600 });
  },
  async clear(ctx) {
    const authPath = path.join(codexHome(), "auth.json");
    const backup = path.join(ctx.globalStorageUri.fsPath, CODEX_BACKUP);
    if (fs.existsSync(backup)) await fs.promises.copyFile(backup, authPath);
  },
};

export const providers: Record<Kind, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
};
