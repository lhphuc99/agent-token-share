import * as vscode from "vscode";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { Store, type Kind } from "./store";
import { remainingMins } from "./live-cred";

export interface PanelActions {
  switch(id: string): void;
  remove(id: string): void;
  add(): void;
  exportLogin(kind?: Kind): void;
  ownLogin(kind: Kind): void;
}

export interface PanelCallHandler {
  handle(method: string, args: Record<string, unknown>): Promise<unknown>;
}

function nonce(): string {
  return randomBytes(24).toString("base64url");
}

export class TokenPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private store: Store,
    private actions: PanelActions,
    private callHandler: PanelCallHandler,
    private extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.post());
    this.post();
  }

  refresh(): void {
    this.post();
  }

  private post(): void {
    const accounts = this.store.list().map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      selected: this.store.selectedId(a.kind) === a.id,
      mins: remainingMins(a.expiresAt),
    }));
    this.view?.webview.postMessage({ type: "state", accounts });
  }

  private onMessage(m: { type?: string; id?: number; method?: string; args?: Record<string, unknown>; [k: string]: unknown }): void {
    switch (m?.type) {
      case "ready":
        return this.post();
      case "switch":
        return m.id != null ? this.actions.switch(String(m.id)) : undefined;
      case "own":
        return (m as { kind?: Kind }).kind ? this.actions.ownLogin((m as { kind: Kind }).kind) : undefined;
      case "exportLogin":
        return this.actions.exportLogin((m as { kind?: Kind }).kind);
      case "call":
        if (typeof m.id === "number" && typeof m.method === "string") {
          const callId = m.id;
          this.callHandler.handle(m.method, m.args ?? {}).then(
            (value) => this.view?.webview.postMessage({ type: "result", id: callId, value }),
            (err) => this.view?.webview.postMessage({ type: "result", id: callId, value: { error: String((err as Error)?.message ?? err) } }),
          );
        }
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
    ].join("; ");
    const head = [
      "<!DOCTYPE html><html><head>",
      '<meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ];
    try {
      const mediaPath = (file: string) => vscode.Uri.joinPath(this.extensionUri, "media", file).fsPath;
      const css = fs.readFileSync(mediaPath("panel.css"), "utf8");
      const icons = fs.readFileSync(mediaPath("icons.js"), "utf8");
      const js = fs.readFileSync(mediaPath("panel.js"), "utf8");
      return [
        ...head,
        `<style>${css}</style>`,
        "</head><body>",
        '<div id="app"></div>',
        `<script nonce="${n}">${icons}</script>`,
        `<script nonce="${n}">${js}</script>`,
        "</body></html>",
      ].join("");
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      return [
        ...head,
        "</head><body>",
        `<p style="padding:12px;color:red;font-family:monospace">Panel load error:<br>${msg}<br><br>extensionUri: ${this.extensionUri}</p>`,
        "</body></html>",
      ].join("");
    }
  }
}
