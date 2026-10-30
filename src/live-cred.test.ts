import { describe, test, expect } from "bun:test";
import { remainingMins, jwtExp, parseCodexAuth } from "./live-cred";

function withFixedNow<T>(ms: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload: object, header: object = { alg: "none", typ: "JWT" }): string {
  return [base64url(JSON.stringify(header)), base64url(JSON.stringify(payload)), "sig"].join(".");
}

// Finds a payload whose standard-base64 form contains '+' or '/', so the test
// actually exercises jwtExp's '-'/'_' -> '+'/'/'' substitution instead of
// passing by coincidence on input that never needed it. The padding bytes must
// vary (not repeat a single char) or the base64 just cycles through the same
// few groups and never lands on 62/63.
function payloadNeedingUrlSafeChars(exp: number): object {
  for (let i = 0; i < 64; i++) {
    let pad = "";
    for (let j = 0; j < i; j++) pad += String.fromCharCode(33 + ((j * 7) % 90));
    const payload = { exp, pad };
    const std = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    if (std.includes("+") || std.includes("/")) return payload;
  }
  throw new Error("test setup: no padding length produced a '+'/'/' in base64");
}

describe("remainingMins", () => {
  const now = 1_700_000_000_000; // fixed "current time" in ms

  test("returns null when expiresAt is missing or zero", () => {
    expect(remainingMins(undefined)).toBeNull();
    expect(remainingMins(0)).toBeNull();
  });

  test("accepts epoch seconds", () => {
    const expiresAtSeconds = now / 1000 + 5 * 60;
    withFixedNow(now, () => expect(remainingMins(expiresAtSeconds)).toBe(5));
  });

  test("accepts epoch milliseconds", () => {
    const expiresAtMs = now + 5 * 60_000;
    withFixedNow(now, () => expect(remainingMins(expiresAtMs)).toBe(5));
  });

  test("clamps past timestamps to 0 instead of going negative", () => {
    withFixedNow(now, () => expect(remainingMins(now - 60_000)).toBe(0));
  });

  test("rounds to the nearest minute", () => {
    withFixedNow(now, () => expect(remainingMins(now + 90_000)).toBe(2));
  });
});

describe("jwtExp", () => {
  test("reads the exp claim from a well-formed JWT", () => {
    const exp = 1893456000;
    expect(jwtExp(makeJwt({ exp }))).toBe(exp);
  });

  test("decodes base64url payloads needing '-'/'_' substitution", () => {
    const exp = 1893456000;
    const payload = payloadNeedingUrlSafeChars(exp);
    const seg = base64url(JSON.stringify(payload));
    expect(seg).toMatch(/[-_]/); // sanity: the test actually hits that code path
    expect(jwtExp(makeJwt(payload))).toBe(exp);
  });

  test("returns undefined for a string with fewer than 2 segments", () => {
    expect(jwtExp("not-a-jwt")).toBeUndefined();
  });

  test("returns undefined when the payload segment isn't valid base64/JSON", () => {
    expect(jwtExp("header.%%%not-base64%%%.sig")).toBeUndefined();
  });

  test("returns undefined when exp is absent or not a number", () => {
    expect(jwtExp(makeJwt({ sub: "user" }))).toBeUndefined();
    expect(jwtExp(makeJwt({ exp: "soon" }))).toBeUndefined();
  });
});

describe("parseCodexAuth", () => {
  test("blanks refresh_token while keeping the access token and exp", () => {
    const exp = 1893456000;
    const accessToken = makeJwt({ exp });
    const raw = JSON.stringify({
      tokens: { access_token: accessToken, refresh_token: "r-super-secret-refresh" },
      last_refresh: "2024-01-01T00:00:00Z",
    });

    const result = parseCodexAuth(raw);

    expect(result).not.toBeNull();
    expect(result!.expiresAt).toBe(exp);
    const parsed = JSON.parse(result!.authJson);
    expect(parsed.tokens.refresh_token).toBe("");
    expect(parsed.tokens.access_token).toBe(accessToken);
    expect(parsed.last_refresh).toBe("2024-01-01T00:00:00Z");
  });

  test("still blanks refresh_token when the access token isn't a JWT", () => {
    const raw = JSON.stringify({ tokens: { access_token: "opaque-token", refresh_token: "secret" } });

    const result = parseCodexAuth(raw);

    expect(result).not.toBeNull();
    expect(result!.expiresAt).toBeUndefined();
    expect(JSON.parse(result!.authJson).tokens.refresh_token).toBe("");
  });

  test("adds an empty refresh_token field even if none existed before", () => {
    const raw = JSON.stringify({ tokens: { access_token: "opaque-token" } });
    const parsed = JSON.parse(parseCodexAuth(raw)!.authJson);
    expect(parsed.tokens.refresh_token).toBe("");
  });

  test("returns null when tokens.access_token is missing", () => {
    expect(parseCodexAuth(JSON.stringify({ tokens: {} }))).toBeNull();
    expect(parseCodexAuth(JSON.stringify({}))).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseCodexAuth("{not json")).toBeNull();
  });
});
