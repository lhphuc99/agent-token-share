import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

// The Claude Code extension spawns `<wrapper> <claude-binary> <args...>`, re-reading
// its setting at every spawn. The wrapper injects the selected token from a 0600 file,
// so the secret never has to sit in settings.json.

export function tokenFilePath(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, "current-token");
}

export async function ensureStorage(ctx: vscode.ExtensionContext): Promise<void> {
  await fs.promises.mkdir(ctx.globalStorageUri.fsPath, { recursive: true });
}

export async function writeCurrentToken(ctx: vscode.ExtensionContext, token: string): Promise<void> {
  await ensureStorage(ctx);
  await fs.promises.writeFile(tokenFilePath(ctx), token, { mode: 0o600 });
}

export async function clearCurrentToken(ctx: vscode.ExtensionContext): Promise<void> {
  await fs.promises.rm(tokenFilePath(ctx), { force: true });
}

function wrapperPath(ctx: vscode.ExtensionContext): string {
  const name = process.platform === "win32" ? "wrap.cmd" : "wrap.sh";
  return path.join(ctx.globalStorageUri.fsPath, name);
}

export async function installWrapper(ctx: vscode.ExtensionContext): Promise<string> {
  await ensureStorage(ctx);
  const tf = tokenFilePath(ctx);
  const p = wrapperPath(ctx);
  if (process.platform === "win32") {
    const cmd = [
      "@echo off",
      `if exist "${tf}" set /p CTS_TOKEN=<"${tf}"`,
      "if defined CTS_TOKEN set CLAUDE_CODE_OAUTH_TOKEN=%CTS_TOKEN%",
      "%*",
      "",
    ].join("\r\n");
    await fs.promises.writeFile(p, cmd);
  } else {
    const sh = [
      "#!/bin/sh",
      `TOKEN="$(cat "${tf}" 2>/dev/null)"`,
      `[ -n "$TOKEN" ] && export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"`,
      `exec "$@"`,
      "",
    ].join("\n");
    await fs.promises.writeFile(p, sh, { mode: 0o755 });
  }
  return p;
}

export async function setClaudeWrapperSetting(p: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("claudeCode")
    .update("claudeProcessWrapper", p, vscode.ConfigurationTarget.Global);
}

// Only clears the setting if it still points at our own wrapper.
export async function clearClaudeWrapperSetting(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("claudeCode");
  const cur = cfg.inspect<string>("claudeProcessWrapper")?.globalValue;
  if (cur && /[/\\]wrap\.(sh|cmd)$/.test(cur)) {
    await cfg.update("claudeProcessWrapper", undefined, vscode.ConfigurationTarget.Global);
  }
}

export function claudeCodeInstalled(): boolean {
  return !!vscode.extensions.getExtension("anthropic.claude-code");
}
