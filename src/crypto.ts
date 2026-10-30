import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const MAGIC = "CTS1.";

// Self-contained blob: salt(16) | iv(12) | tag(16) | ciphertext, base64, prefixed.
// Needs only the blob + the passphrase to decrypt; a wrong passphrase fails the GCM tag.
export function encryptWithPass(plain: string, pass: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return MAGIC + Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptWithPass(blob: string, pass: string): string {
  const b = Buffer.from(blob.replace(/^CTS1\./, "").trim(), "base64");
  const salt = b.subarray(0, 16);
  const iv = b.subarray(16, 28);
  const tag = b.subarray(28, 44);
  const ct = b.subarray(44);
  const key = scryptSync(pass, salt, 32);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
