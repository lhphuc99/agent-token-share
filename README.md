# Agent Token Share

A VS Code extension to **store, switch, and securely share short-lived Claude and Codex tokens** — without logging into any account inside this extension. It reads the login you already have, snapshots a short-lived token, and lets you hand it to a teammate encrypted with a key you choose.

> **Terms of service.** These tokens are tied to a personal Claude / ChatGPT (Codex) subscription and count against that subscription's limits. Sharing them with other people is subscription sharing, which the providers' terms restrict and which can get accounts rate-limited or banned. Use it for your own accounts, or keep it strictly internal. Prefer official API keys / Team / Enterprise plans where you can.

## What it does

- **Export Current Login (short-lived)** — snapshots the short-lived access token from your existing Claude *or* Codex login, encrypts it with your share key, and copies it or saves a `.ctstoken` file. No login flow runs here; it reads the login you already have. The **refresh token is never read or shared**, so the shared token simply dies when it expires (a few hours) and the recipient cannot renew it.
- **Switch Account (Claude / Codex)** — picks which token the next Claude/Codex session (extension *and* terminal) uses. Per-provider; includes "use own login" to restore.
- **Import Shared Token** — paste the blob or open the file, enter the key, store it, switch to it.
- **Set Share Key** — the passphrase for export/import. Give it to the other side **separately** from the blob.
- **Add Claude Token** — paste a long-lived `setup-token` or an `sk-ant-api…` API key (optional; for when you want a stored token rather than a short-lived snapshot).
- **Export Stored Token / Verify / Open Claude Terminal / Install·Disable Wrapper** — helpers.

Short-lived tokens show a countdown; when expired, the owner re-exports and re-sends.

## The panel

A **Token Share** view in the Activity Bar (webview) shows each account as a card: provider chip (Claude / Codex), label, an ACTIVE pill, a countdown meter, and Switch / Share / Remove buttons. The top has a primary "Share current login" plus Add / Import; a footer restores each provider's own login. It uses VS Code's own theme variables, so it matches light and dark automatically, and the status bar (left) mirrors the active accounts.

## Run it (development)

Requires [bun](https://bun.sh) and VS Code ≥ 1.94.

```bash
bun install
bun run compile      # or: bun run watch
```

Open this folder in VS Code and press **F5**. A second window opens with the extension loaded. Run the **Token Share:** commands from the Command Palette; the status bar (left) shows the selected Claude/Codex accounts.

## How injection works (per provider)

**Claude** — the extension installs a `claudeProcessWrapper` script in its own storage. The Claude Code extension spawns `wrapper <claude> <args>` each session; the wrapper reads the selected token from a `0600` file and exports `CLAUDE_CODE_OAUTH_TOKEN`. Nothing secret is written to `settings.json`. Terminals get the token via `createTerminal({ env })`. Reading your live Claude login is Keychain on macOS (**one-time** "Always Allow" prompt on the owner's machine) or `~/.claude/.credentials.json` on Linux/Windows.

**Codex** — both the Codex CLI and the Codex VS Code extension read `~/.codex/auth.json` (default `CODEX_HOME`), so switching = swapping that file. Your own login is backed up on first switch; "Codex: use own login" restores it. The shared `auth.json` keeps the short-lived `tokens.access_token` but **blanks `tokens.refresh_token`** (codex requires the field to exist but accepts an empty string), so it auto-expires and cannot be refreshed by the recipient. Reading `~/.codex/auth.json` is a plain file — **no keychain prompt on any OS**.

## How sharing works

1. **Owner:** *Set Share Key* → *Export Current Login* → pick Claude or Codex → Copy / Save.
2. Send the **blob** to a teammate (chat/file) and the **key** separately. Blob + key apart = the encryption actually protects it.
3. **Recipient:** *Set Share Key* (the key you were given) → *Import Shared Token* → *Switch* to it.

Because the refresh token never leaves the owner, the shared token expires in a few hours and the owner re-exports a fresh one when needed.

## Verified

Built and checked on macOS (VS Code 1.144 / Node 24): `bun run compile` + `typecheck` clean; `activate()` registers all commands; crypto round-trips and rejects a wrong key; Codex `auth.json` parsing keeps the access token, blanks the refresh token, and decodes the JWT `exp`. Codex accepts an `auth.json` with an empty `refresh_token` (`codex login status` → "Logged in using ChatGPT").

## Limitations

- Switch applies to **new** sessions/terminals, not ones already running.
- Codex switching **overwrites `~/.codex/auth.json`** (backed up first; restore with "Codex: use own login").
- Needs an **F5 test** for: the real macOS Keychain read (prompts once) and a real `codex` run on a shared empty-refresh token (verified via `login status`, not a full model call).
- Windows wrapper (`wrap.cmd`) is less tested than the POSIX one.
- `Verify` hits an undocumented endpoint; a non-200 only warns.

## Package (optional)

```bash
bunx @vscode/vsce package   # produces a .vsix to install locally
```
