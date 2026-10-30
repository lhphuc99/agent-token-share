import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

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

function shimDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, "shim");
}

// A `claude` on PATH that shadows the real one in every integrated terminal. Unlike a
// static env var (which freezes at terminal-creation time and goes stale across a later
// switch), this re-reads the token file on every invocation — same freshness as the
// claudeProcessWrapper above, just reachable from a bare terminal instead of only from
// the Claude Code extension's own spawns.
export async function installClaudeShim(ctx: vscode.ExtensionContext): Promise<string> {
  const dir = shimDir(ctx);
  await fs.promises.mkdir(dir, { recursive: true });
  const tf = tokenFilePath(ctx);
  if (process.platform === "win32") {
    // Resolved once here (not at shell runtime, batch has no clean way to strip PATH
    // entries); re-resolved on every activate() so a later claude reinstall self-heals.
    const real = await pexec("where", ["claude"])
      .then((r) => r.stdout.split(/\r?\n/).find((l) => l.trim())?.trim())
      .catch(() => undefined);
    const cmd = [
      "@echo off",
      `if exist "${tf}" set /p CTS_TOKEN=<"${tf}"`,
      "if defined CTS_TOKEN set CLAUDE_CODE_OAUTH_TOKEN=%CTS_TOKEN%",
      real ? `"${real}" %*` : 'echo Agent Token Share: real claude not found on PATH 1>&2 & exit /b 127',
      "",
    ].join("\r\n");
    await fs.promises.writeFile(path.join(dir, "claude.cmd"), cmd);
  } else {
    // Strip our own dir from PATH before looking up `claude`, so we find the real binary
    // instead of recursing into ourselves.
    const sh = [
      "#!/bin/sh",
      `NEWPATH="$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "${dir}" | tr '\\n' ':')"`,
      `REAL="$(PATH="\${NEWPATH%:}" command -v claude)"`,
      `if [ -z "$REAL" ]; then echo "Agent Token Share: real claude not found on PATH" >&2; exit 127; fi`,
      `TOKEN="$(cat "${tf}" 2>/dev/null)"`,
      `[ -n "$TOKEN" ] && export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"`,
      `exec "$REAL" "$@"`,
      "",
    ].join("\n");
    await fs.promises.writeFile(path.join(dir, "claude"), sh, { mode: 0o755 });
  }
  return dir;
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
