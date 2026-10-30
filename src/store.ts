import * as vscode from "vscode";

export type Kind = "claude" | "codex";

export interface Account {
  id: string;
  label: string;
  kind: Kind;
  expiresAt?: number;
}

const KEY_LIST = "accounts";
const SECRET_SHAREKEY = "shareKey";

// Token values live in SecretStorage (OS keychain own-item: no macOS prompt on read).
// Only labels + ids + kind are in globalState. Selection is per provider.
export class Store {
  constructor(private ctx: vscode.ExtensionContext) {}

  list(): Account[] {
    return this.ctx.globalState
      .get<Account[]>(KEY_LIST, [])
      .map((a) => ({ ...a, kind: a.kind ?? "claude" }));
  }

  find(id: string): Account | undefined {
    return this.list().find((a) => a.id === id);
  }

  async add(label: string, token: string, kind: Kind, expiresAt?: number): Promise<Account> {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.ctx.secrets.store(`tok:${id}`, token);
    const acc: Account = expiresAt ? { id, label, kind, expiresAt } : { id, label, kind };
    await this.ctx.globalState.update(KEY_LIST, [...this.list(), acc]);
    return acc;
  }

  async remove(id: string): Promise<void> {
    const acc = this.find(id);
    await this.ctx.secrets.delete(`tok:${id}`);
    await this.ctx.globalState.update(KEY_LIST, this.list().filter((a) => a.id !== id));
    if (acc && this.selectedId(acc.kind) === id) await this.setSelected(acc.kind, undefined);
  }

  token(id: string): Thenable<string | undefined> {
    return this.ctx.secrets.get(`tok:${id}`);
  }

  selectedId(kind: Kind): string | undefined {
    return this.ctx.globalState.get<string>(`selected:${kind}`);
  }

  async setSelected(kind: Kind, id: string | undefined): Promise<void> {
    await this.ctx.globalState.update(`selected:${kind}`, id);
  }

  async shareKey(promptIfMissing = true): Promise<string | undefined> {
    let k = await this.ctx.secrets.get(SECRET_SHAREKEY);
    if (!k && promptIfMissing) {
      k = await vscode.window.showInputBox({
        prompt: "Set your share key (agree the same value with the people you share with)",
        password: true,
        ignoreFocusOut: true,
      });
      if (k) await this.ctx.secrets.store(SECRET_SHAREKEY, k);
    }
    return k || undefined;
  }

  async setShareKey(k: string): Promise<void> {
    await this.ctx.secrets.store(SECRET_SHAREKEY, k);
  }

  async clearShareKey(): Promise<void> {
    await this.ctx.secrets.delete(SECRET_SHAREKEY);
  }

  async getPpmPassword(): Promise<string | null> {
    return (await this.ctx.secrets.get("ppm:defaultPassword")) ?? null;
  }

  async setPpmPassword(pw: string | null): Promise<void> {
    if (pw) {
      await this.ctx.secrets.store("ppm:defaultPassword", pw);
    } else {
      await this.ctx.secrets.delete("ppm:defaultPassword");
    }
  }
}
