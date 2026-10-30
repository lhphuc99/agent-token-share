import { describe, test, expect } from "bun:test";
import { randomBytes, createCipheriv, scryptSync } from "node:crypto";
import { decryptPPMExport } from "./ppm-import";

// PPM's own encrypter isn't part of this repo, so this rebuilds the documented
// envelope format (version 1, scrypt N=16384 r=8 p=1, aes-256-gcm) to exercise
// decryptPPMExport the way a real PPM backup would.
function makePpmEnvelope(rows: unknown[], password: string): string {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(rows), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("base64"),
  });
}

const PASSWORD = "export-password";
const ROWS = [
  { id: "1", label: "Work", access_token: "tok1", expires_at: 1700000000 },
  { id: "2", email: "a@b.com", access_token: "tok2" },
  { id: "3", access_token: "tok3" },
  { id: "4", label: "No token, should be dropped" },
];

describe("decryptPPMExport", () => {
  test("round-trips a PPM backup into importable accounts", () => {
    const blob = makePpmEnvelope(ROWS, PASSWORD);

    const accounts = decryptPPMExport(blob, PASSWORD);

    expect(accounts).toHaveLength(3); // the row without access_token is dropped
    expect(accounts[0]).toEqual({ id: "1", label: "Work", kind: "claude", token: "tok1", expiresAt: 1700000000 });
    expect(accounts[1].label).toBe("a@b.com"); // falls back to email when label is missing
    expect(accounts[2].label).toBe("PPM Claude"); // falls back further when both are missing
    expect(accounts[2].expiresAt).toBeUndefined();
    expect(accounts.every((a) => a.kind === "claude")).toBe(true);
  });

  test("fails closed on the wrong password", () => {
    const blob = makePpmEnvelope(ROWS, PASSWORD);
    expect(() => decryptPPMExport(blob, "wrong-password")).toThrow("Wrong password or corrupted backup.");
  });

  test("fails closed when the ciphertext has been tampered with", () => {
    const envelope = JSON.parse(makePpmEnvelope(ROWS, PASSWORD));
    const ct = Buffer.from(envelope.ciphertext, "base64");
    ct[ct.length - 1] ^= 0xff;
    envelope.ciphertext = ct.toString("base64");
    expect(() => decryptPPMExport(JSON.stringify(envelope), PASSWORD)).toThrow("Wrong password or corrupted backup.");
  });

  test("rejects input that isn't JSON", () => {
    expect(() => decryptPPMExport("not json at all", PASSWORD)).toThrow("Not a valid PPM backup (expected JSON).");
  });

  test("rejects an unsupported envelope version/kdf", () => {
    const envelope = JSON.parse(makePpmEnvelope(ROWS, PASSWORD));
    envelope.version = 2;
    expect(() => decryptPPMExport(JSON.stringify(envelope), PASSWORD)).toThrow("Unsupported PPM backup version.");
  });
});
