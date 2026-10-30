import { describe, test, expect } from "bun:test";
import { encryptWithPass, decryptWithPass } from "./crypto";

describe("encryptWithPass / decryptWithPass", () => {
  test("round-trips plaintext with the same passphrase", () => {
    const plain = "sk-ant-oat01-super-secret-token";
    const blob = encryptWithPass(plain, "correct horse battery staple");
    expect(decryptWithPass(blob, "correct horse battery staple")).toBe(plain);
  });

  test("round-trips empty string and unicode plaintext", () => {
    const pass = "pass";
    expect(decryptWithPass(encryptWithPass("", pass), pass)).toBe("");
    const unicode = "tokę§Ν 🔑 日本語";
    expect(decryptWithPass(encryptWithPass(unicode, pass), pass)).toBe(unicode);
  });

  test("prefixes the blob with the format marker", () => {
    expect(encryptWithPass("x", "pass")).toStartWith("CTS1.");
  });

  test("never reuses salt/iv across calls, even for identical input", () => {
    const a = encryptWithPass("same plaintext", "same pass");
    const b = encryptWithPass("same plaintext", "same pass");
    expect(a).not.toBe(b);
  });

  test("fails closed when decrypting with the wrong passphrase", () => {
    const blob = encryptWithPass("secret", "right-pass");
    expect(() => decryptWithPass(blob, "wrong-pass")).toThrow();
  });

  test("fails closed when the ciphertext has been tampered with", () => {
    const blob = encryptWithPass("secret", "pass");
    const raw = Buffer.from(blob.slice("CTS1.".length), "base64");
    raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext
    const tampered = "CTS1." + raw.toString("base64");
    expect(() => decryptWithPass(tampered, "pass")).toThrow();
  });
});
