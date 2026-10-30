import * as vscode from "vscode";
import * as fs from "node:fs";
import { Store, type Kind } from "./store";
import { encryptWithPass, decryptWithPass } from "./crypto";
import { remainingMins } from "./live-cred";
import { providers, claudeProvider, type ExportPayload } from "./providers";
import { TokenPanel, type PanelActions, type PanelCallHandler } from "./panel";
import {
  installWrapper,
  setClaudeWrapperSetting,
  clearClaudeWrapperSetting,
  ensureStorage,
  claudeCodeInstalled,
} from "./wrapper";
import { importFromPPM, decryptPPMExport, type PpmAccount } from "./ppm-import";

let ctx: vscode.ExtensionContext;
let store: Store;
let statusBar: vscode.StatusBarItem;
let panel: TokenPanel;

type IdPick = vscode.QuickPickItem & { id: string };
type KindPick = vscode.QuickPickItem & { provider: Kind };

export async function activate(context: vscode.ExtensionContext) {
  ctx = context;
  store = new Store(ctx);
  await ensureStorage(ctx);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "agentTokenShare.switch";
  ctx.subscriptions.push(statusBar);

  const actions: PanelActions = {
    switch: (id) => void doSwitch(id),
    remove: (id) => void removeById(id),
    add: () => void addToken(),
    exportLogin: () => void exportCurrentLogin(),
    ownLogin: (kind) => void clearProvider(kind),
  };

  const callHandler: PanelCallHandler = { handle: handlePanelCall };

  panel = new TokenPanel(store, actions, callHandler, ctx.extensionUri);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("tokenShareView", panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  refreshUI();

  if (vscode.workspace.getConfiguration("agentTokenShare").get<boolean>("manageClaudeWrapper", true)) {
    const notified = ctx.globalState.get<boolean>("wrapperAutoSetupNotified");
    const installed = await setupWrapper(false);
    if (installed && !notified) {
      void (async () => {
        await ctx.globalState.update("wrapperAutoSetupNotified", true);
        const action = await vscode.window.showInformationMessage(
          "Agent Token Share configured Claude Code to use the selected token.",
          "Undo",
        );
        if (action === "Undo") {
          await disableWrapper();
          await vscode.workspace
            .getConfiguration("agentTokenShare")
            .update("manageClaudeWrapper", false, vscode.ConfigurationTarget.Global);
        }
      })();
    }
  }

  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("agentTokenShare.addToken", addToken);
  reg("agentTokenShare.switch", switchAccount);
  reg("agentTokenShare.remove", removeAccount);
  reg("agentTokenShare.exportToken", exportToken);
  reg("agentTokenShare.exportLogin", exportCurrentLogin);
  reg("agentTokenShare.importToken", importToken);
  reg("agentTokenShare.setKey", setKey);
  reg("agentTokenShare.verify", verifyCurrent);
  reg("agentTokenShare.openTerminal", openTerminal);
  reg("agentTokenShare.refresh", refreshUI);
  reg("agentTokenShare.setupWrapper", () => setupWrapper(true));
  reg("agentTokenShare.disableWrapper", disableWrapper);
}

export function deactivate() {}

// --- panel call handler (webview -> host async RPC) --------------------------

async function handlePanelCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "getShareKey": {
      return (await ctx.secrets.get("shareKey")) || null;
    }
    case "setShareKey": {
      const k = String(args.key ?? "");
      if (k) await store.setShareKey(k);
      return { ok: true };
    }
    case "clearShareKey": {
      await store.clearShareKey();
      return { ok: true };
    }
    case "copyToClipboard": {
      await vscode.env.clipboard.writeText(String(args.text ?? ""));
      return { ok: true };
    }
    case "addToken": {
      const token = String(args.token ?? "").trim();
      const label = String(args.label ?? "account").trim() || "account";
      if (!claudeProvider.validate(token)) {
        return { error: "Expected a token starting with sk-ant-oat or sk-ant-api." };
      }
      await store.add(label, token, "claude");
      refreshUI();
      return { ok: true };
    }
    case "importToken": {
      const blob = String(args.blob ?? "").trim();
      const key = String(args.key ?? "").trim();
      const label = String(args.label ?? "").trim();
      if (!blob || !key) return { error: "Blob and key are both required." };
      let data: ExportPayload;
      try {
        data = JSON.parse(decryptWithPass(blob, key));
      } catch {
        return { error: "Decrypt failed — wrong key or corrupt blob." };
      }
      const prov = providers[(data.kind ?? "claude") as Kind];
      if (!prov || !data.token || !prov.validate(data.token)) {
        return { error: "Decrypted content is not a valid token." };
      }
      if (remainingMins(data.expiresAt) === 0) {
        return { error: "This token has already expired — ask the owner for a fresh one." };
      }
      const accLabel = label || data.label || `${prov.name} shared`;
      const acc = await store.add(accLabel, data.token, prov.kind, data.expiresAt);
      await doSwitch(acc.id);
      return { ok: true };
    }
    case "exportById": {
      const id = String(args.id ?? "");
      const key = String(args.key ?? "").trim();
      const how = String(args.method ?? "copy");
      const acc = store.find(id);
      const token = acc && (await store.token(id));
      if (!acc || !token) return { error: "Token not found." };
      if (!key) return { error: "Enter the share key." };
      // Only persist on first-time setup; a one-off key must not replace an existing saved key
      const existingKey = await store.shareKey(false);
      if (!existingKey) await store.setShareKey(key);
      const payload: ExportPayload = { kind: acc.kind, token, expiresAt: acc.expiresAt, label: acc.label };
      const blob = encryptWithPass(JSON.stringify(payload), key);
      if (how === "file") {
        const uri = await vscode.window.showSaveDialog({ filters: { "Shared token": ["ctstoken"] }, saveLabel: "Export encrypted token" });
        if (!uri) return { error: "Cancelled." };
        await fs.promises.writeFile(uri.fsPath, blob);
        return { ok: true };
      }
      await vscode.env.clipboard.writeText(blob);
      return { ok: true };
    }
    case "removeById": {
      const id = String(args.id ?? "");
      await store.remove(id);
      refreshUI();
      return { ok: true };
    }
    case "pickImportFile": {
      const uri = await vscode.window.showOpenDialog({ filters: { "Shared token": ["ctstoken"] }, canSelectMany: false });
      if (!uri?.[0]) return { blob: null };
      const blob = await fs.promises.readFile(uri[0].fsPath, "utf8");
      return { blob };
    }
    case "getPpmPassword": {
      return await store.getPpmPassword();
    }
    case "setPpmPassword": {
      const pw = String(args.password ?? "").trim();
      await store.setPpmPassword(pw || null);
      return { ok: true };
    }
    case "fetchUsage": {
      const reqId = args.id ? String(args.id) : store.selectedId("claude");
      const id = reqId;
      const token = id ? await store.token(id) : null;
      if (!token) return { error: "No Claude account active." };
      if (token.startsWith("sk-ant-api")) return { error: "API keys don't have usage data." };
      const ctrl = new AbortController();
      const fetchTimer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await (globalThis as { fetch: Function }).fetch(
          "https://api.anthropic.com/api/oauth/usage",
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "anthropic-beta": "oauth-2025-04-20",
            },
            signal: ctrl.signal,
          },
        );
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const raw = await res.json() as Record<string, unknown>;

        const parseBucket = (b: Record<string, unknown> | null | undefined, windowHours: number) => {
          if (!b) return null;
          const utilization = ((b.utilization as number) ?? 0) / 100;
          const resetsAt = (b.resets_at as string) ?? "";
          const diff = resetsAt ? new Date(resetsAt).getTime() - Date.now() : 0;
          const totalMins = diff > 0 ? Math.ceil(diff / 60000) : 0;
          return {
            utilization,
            resetsAt,
            resetsInMinutes: windowHours <= 5 ? totalMins : null,
            resetsInHours: windowHours > 5 ? Math.round((totalMins / 60) * 100) / 100 : null,
          };
        };

        const scoped: Array<{ label: string; utilization: number; resetsAt: string; resetsInHours: number | null }> = [];
        if (Array.isArray(raw.limits)) {
          for (const l of raw.limits as Array<Record<string, unknown>>) {
            if (l?.kind !== "weekly_scoped") continue;
            const label = (l?.scope as Record<string, unknown>)?.model as Record<string, unknown>;
            const displayName = label?.display_name;
            if (typeof displayName !== "string" || !displayName.trim()) continue;
            if (typeof l.percent !== "number") continue;
            const resetsAt = typeof l.resets_at === "string" ? l.resets_at : "";
            const diff = resetsAt ? new Date(resetsAt).getTime() - Date.now() : 0;
            const totalMins = diff > 0 ? Math.ceil(diff / 60000) : 0;
            scoped.push({
              label: displayName.trim(),
              utilization: l.percent / 100,
              resetsAt,
              resetsInHours: Math.round((totalMins / 60) * 100) / 100,
            });
          }
        }

        return {
          session: parseBucket(raw.five_hour as Record<string, unknown>, 5),
          weekly: parseBucket(raw.seven_day as Record<string, unknown>, 168),
          scoped,
        };
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      } finally {
        clearTimeout(fetchTimer);
      }
    }
    case "whoAmI": {
      const id = store.selectedId("claude");
      const token = id ? await store.token(id) : null;
      if (!token) return { error: "No Claude account is active — click Switch first." };
      if (token.startsWith("sk-ant-api")) {
        return { error: "API keys don't have a profile. Check the label in the panel." };
      }
      const whoCtrl = new AbortController();
      const whoTimer = setTimeout(() => whoCtrl.abort(), 8000);
      try {
        const res = await (globalThis as { fetch: Function }).fetch(
          "https://api.anthropic.com/api/oauth/profile",
          { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: whoCtrl.signal },
        );
        if (!res.ok) return { error: `Profile fetch failed: HTTP ${res.status}` };
        const d = await res.json() as { account?: { email?: string; full_name?: string; display_name?: string }; organization?: { name?: string } };
        return {
          email: d.account?.email ?? null,
          name: d.account?.full_name || d.account?.display_name || null,
          org: d.organization?.name ?? null,
        };
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      } finally {
        clearTimeout(whoTimer);
      }
    }
    case "importFromPPMBlob": {
      const blob = String(args.blob ?? "").trim();
      const password = String(args.password ?? "").trim();
      if (!blob || !password) return { error: "Blob and password are both required." };
      try {
        return await mergePpmAccounts(decryptPPMExport(blob, password));
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      }
    }
    case "importFromPPM": {
      try {
        return await mergePpmAccounts(importFromPPM());
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      }
    }
    default:
      return { error: "Unknown method: " + method };
  }
}

// --- commands (kept for palette / status bar) ---------------------------------

async function addToken() {
  const token = await vscode.window.showInputBox({
    prompt: "Paste a Claude setup-token (run `claude setup-token`) or an sk-ant-api… API key",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v && claudeProvider.validate(v.trim()) ? undefined : "Expected a token starting with sk-ant-oat or sk-ant-api",
  });
  if (!token) return;
  const label =
    (await vscode.window.showInputBox({ prompt: "Label for this account", value: "", ignoreFocusOut: true })) ||
    "account";
  const acc = await store.add(label, token.trim(), "claude");
  refreshUI();
  const sw = await vscode.window.showQuickPick(["Switch to it now", "Later"], { placeHolder: `Added "${label}". Use it now?` });
  if (sw === "Switch to it now") await doSwitch(acc.id);
}

async function switchAccount() {
  const accs = store.list();
  const items: IdPick[] = [
    { label: "$(circle-slash) Claude: use own login", id: "__none__claude" },
    { label: "$(circle-slash) Codex: use own login", id: "__none__codex" },
    ...accs.map((a) => {
      const mins = remainingMins(a.expiresAt);
      const tail = mins == null ? "" : mins === 0 ? " (expired)" : ` (~${mins}m left)`;
      const sel = store.selectedId(a.kind) === a.id ? "$(check) " : "";
      return { label: `${sel}${a.label}${tail}`, description: a.kind, id: a.id };
    }),
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Switch account (applies to NEW sessions/terminals)" });
  if (!pick) return;
  if (pick.id === "__none__claude" || pick.id === "__none__codex") {
    await clearProvider(pick.id.endsWith("codex") ? "codex" : "claude");
    return;
  }
  await doSwitch(pick.id);
}

async function clearProvider(kind: Kind) {
  await providers[kind].clear(ctx);
  await store.setSelected(kind, undefined);
  refreshUI();
  vscode.window.showInformationMessage(`Cleared — new ${providers[kind].name} sessions use its own login.`);
}

async function doSwitch(id: string) {
  const acc = store.find(id);
  const token = acc && (await store.token(id));
  if (!acc || !token) {
    vscode.window.showErrorMessage("Token not found.");
    return;
  }
  await providers[acc.kind].apply(ctx, token);
  await store.setSelected(acc.kind, acc.id);
  refreshUI();
  const extra = acc.kind === "codex" ? " (replaced ~/.codex/auth.json — use ‘Codex: use own login’ to restore)" : "";
  vscode.window.showInformationMessage(`Switched ${providers[acc.kind].name} to "${acc.label}". Start a new session/terminal to use it.${extra}`);
}

async function removeAccount() {
  if (!store.list().length) return;
  const pick = await pickAccount("Remove which account?");
  if (pick) await removeById(pick.id);
}

async function removeById(id: string) {
  await store.remove(id);
  refreshUI();
  vscode.window.showInformationMessage("Removed.");
}

async function exportCurrentLogin() {
  const kind = await pickKind("Export which login?");
  if (!kind) return;
  const prov = providers[kind];
  const snap = await prov.snapshot();
  if (!snap) {
    vscode.window.showErrorMessage(`No ${prov.name} login found on this machine. Sign in with ${prov.name} first.`);
    return;
  }
  const key = await store.shareKey(true);
  if (!key) return;
  const payload: ExportPayload = { kind, token: snap.token, expiresAt: snap.expiresAt, label: `${prov.name} shared` };
  await shareBlob(encryptWithPass(JSON.stringify(payload), key), remainingMins(snap.expiresAt));
}

async function exportToken() {
  if (!store.list().length) {
    vscode.window.showWarningMessage("No stored accounts to export.");
    return;
  }
  const pick = await pickAccount("Export which stored account?");
  if (pick) await exportById(pick.id);
}

async function exportById(id: string) {
  const acc = store.find(id);
  const token = acc && (await store.token(id));
  if (!acc || !token) return;
  const key = await store.shareKey(true);
  if (!key) return;
  const payload: ExportPayload = { kind: acc.kind, token, expiresAt: acc.expiresAt, label: acc.label };
  await shareBlob(encryptWithPass(JSON.stringify(payload), key), remainingMins(acc.expiresAt));
}

async function shareBlob(blob: string, mins: number | null) {
  const note = mins == null ? "" : ` (expires in ~${mins} min)`;
  const how = await vscode.window.showQuickPick(["Copy to clipboard", "Save to .ctstoken file"], {
    placeHolder: `Share how${note}? — send the KEY separately, over another channel!`,
  });
  if (how === "Copy to clipboard") {
    await vscode.env.clipboard.writeText(blob);
    vscode.window.showInformationMessage(`Encrypted token copied${note}. Send the KEY separately; re-export when it expires.`);
  } else if (how) {
    const uri = await vscode.window.showSaveDialog({ filters: { "Shared token": ["ctstoken"] }, saveLabel: "Export encrypted token" });
    if (uri) {
      await fs.promises.writeFile(uri.fsPath, blob);
      vscode.window.showInformationMessage(`Saved${note}. Send the KEY separately.`);
    }
  }
}

async function importToken() {
  const src = await vscode.window.showQuickPick(["Paste encrypted blob", "Open .ctstoken file"], { placeHolder: "Import from?" });
  let blob: string | undefined;
  if (src === "Paste encrypted blob") {
    blob = await vscode.window.showInputBox({ prompt: "Paste the encrypted token", password: true, ignoreFocusOut: true });
  } else if (src) {
    const uri = await vscode.window.showOpenDialog({ filters: { "Shared token": ["ctstoken"] }, canSelectMany: false });
    if (uri?.[0]) blob = await fs.promises.readFile(uri[0].fsPath, "utf8");
  }
  if (!blob) return;
  const key = await store.shareKey(true);
  if (!key) return;
  let data: ExportPayload;
  try {
    data = JSON.parse(decryptWithPass(blob.trim(), key));
  } catch {
    vscode.window.showErrorMessage("Decrypt failed — wrong key or corrupt blob.");
    return;
  }
  const prov = providers[(data.kind ?? "claude") as Kind];
  if (!prov || !data.token || !prov.validate(data.token)) {
    vscode.window.showErrorMessage("Decrypted content is not a valid token.");
    return;
  }
  if (remainingMins(data.expiresAt) === 0) {
    vscode.window.showWarningMessage("This token has already expired — ask the owner for a fresh one.");
    return;
  }
  const label =
    (await vscode.window.showInputBox({ prompt: `Label for imported ${prov.name} account`, value: data.label ?? `${prov.name} shared`, ignoreFocusOut: true })) ||
    `${prov.name} shared`;
  const acc = await store.add(label, data.token, prov.kind, data.expiresAt);
  refreshUI();
  const mins = remainingMins(data.expiresAt);
  const sw = await vscode.window.showQuickPick(["Switch to it now", "Later"], {
    placeHolder: mins != null ? `Use it now? (expires in ~${mins} min)` : "Use imported account now?",
  });
  if (sw === "Switch to it now") await doSwitch(acc.id);
}

async function setKey() {
  const k = await vscode.window.showInputBox({ prompt: "Set your share key", password: true, ignoreFocusOut: true });
  if (k) {
    await store.setShareKey(k);
    vscode.window.showInformationMessage("Share key saved.");
  }
}

async function openTerminal() {
  const id = store.selectedId("claude");
  if (!id) {
    vscode.window.showWarningMessage("No Claude account selected. (Codex works in any terminal after switching.)");
    return;
  }
  const token = await store.token(id);
  if (!token) return;
  vscode.window
    .createTerminal({ name: `Claude (${store.find(id)?.label ?? ""})`, env: claudeProvider.terminalEnv!(token) })
    .show();
}

async function verifyCurrent() {
  const id = store.selectedId("claude");
  if (!id) {
    vscode.window.showWarningMessage("No Claude account selected.");
    return;
  }
  const token = await store.token(id);
  if (!token) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Verifying token…" },
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await (globalThis as { fetch: (u: string, i: unknown) => Promise<{ ok: boolean; status: number }> }).fetch(
          "https://api.anthropic.com/api/oauth/usage",
          { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: controller.signal },
        );
        if (res.ok) vscode.window.showInformationMessage("Token is valid.");
        else vscode.window.showWarningMessage(`Token check returned HTTP ${res.status}.`);
      } catch (e) {
        vscode.window.showWarningMessage(`Could not verify: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  );
}

async function setupWrapper(interactive: boolean): Promise<boolean> {
  if (!claudeCodeInstalled()) {
    if (interactive)
      vscode.window.showWarningMessage(
        "Claude Code extension not found. Terminal injection still works; the wrapper only affects the Claude Code extension's own UI.",
      );
    return false;
  }
  try {
    const p = await installWrapper(ctx);
    await setClaudeWrapperSetting(p);
    if (interactive) vscode.window.showInformationMessage("Wrapper installed. New Claude sessions use the selected token.");
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not set wrapper: ${(e as Error).message}`);
    return false;
  }
}

async function disableWrapper() {
  await clearClaudeWrapperSetting();
  vscode.window.showInformationMessage("Wrapper disabled. Claude Code uses its own login again.");
}

// --- helpers ----------------------------------------------------------------

async function mergePpmAccounts(ppmAccounts: PpmAccount[]): Promise<{ count: number; total: number }> {
  const existing = new Set(store.list().map((a) => a.label + "|" + a.kind));
  let count = 0;
  for (const a of ppmAccounts) {
    if (!existing.has(a.label + "|" + a.kind)) {
      await store.add(a.label, a.token, a.kind, a.expiresAt);
      count++;
    }
  }
  refreshUI();
  return { count, total: ppmAccounts.length };
}

async function pickAccount(placeHolder: string): Promise<IdPick | undefined> {
  const items: IdPick[] = store.list().map((a) => ({ label: a.label, description: a.kind, id: a.id }));
  return vscode.window.showQuickPick(items, { placeHolder });
}

async function pickKind(placeHolder: string): Promise<Kind | undefined> {
  const items: KindPick[] = [
    { label: "Claude", provider: "claude" },
    { label: "Codex", provider: "codex" },
  ];
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.provider;
}

function refreshUI() {
  panel?.refresh();
  refreshStatusBar();
}

function refreshStatusBar() {
  const parts = (["claude", "codex"] as Kind[])
    .map((k) => {
      const id = store.selectedId(k);
      const acc = id ? store.find(id) : undefined;
      if (!acc) return null;
      const mins = remainingMins(acc.expiresAt);
      const tail = mins == null ? "" : mins === 0 ? "!" : ` ${mins}m`;
      return `${providers[k].name}:${acc.label}${tail}`;
    })
    .filter(Boolean);
  statusBar.text = `$(key) ${parts.length ? parts.join(" | ") : "Tokens: default"}`;
  statusBar.tooltip = "Switch account / token";
  statusBar.show();
}
