import { describe, expect, test } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { buildVerifier } from "../../server/auth";

const ISSUER = "https://soul.test";

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  return { privateKey, jwksJson: JSON.stringify({ keys: [jwk] }) };
}

async function sign(
  privateKey: CryptoKey,
  opts: { iss?: string; sub?: string | null; aud?: string; expOffset?: number } = {},
) {
  let jwt = new SignJWT(opts.sub === null ? {} : { sub: opts.sub ?? "marcus" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expOffset ?? 3600));
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  return jwt.sign(privateKey);
}

describe("buildVerifier", () => {
  test("null config (no issuer) → verify always true (local dev mode)", async () => {
    expect(await buildVerifier(null).verify("anything")).toBe(true);
  });

  test("valid token → true", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey))).toBe(true);
  });

  test("wrong issuer → false", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { iss: "https://evil.test" }))).toBe(false);
  });

  test("expired → false", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { expOffset: -7200 }))).toBe(false);
  });

  test("missing sub → false", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { sub: null }))).toBe(false);
  });

  test("audience enforced when configured", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson, audience: "julian" });
    expect(await v.verify(await sign(privateKey, { aud: "julian" }))).toBe(true);
    expect(await v.verify(await sign(privateKey, { aud: "other" }))).toBe(false);
    expect(await v.verify(await sign(privateKey))).toBe(false); // no aud claim at all
  });

  test("garbage token → false", async () => {
    const { jwksJson } = await makeKeys();
    expect(await buildVerifier({ issuer: ISSUER, jwksJson }).verify("not-a-jwt")).toBe(false);
  });

  // Additional edge cases the spec implies but the plan's snippet leaves implicit.

  test("token signed by a key outside the JWKS → false", async () => {
    const { jwksJson } = await makeKeys();
    const { privateKey: foreignKey } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(foreignKey))).toBe(false);
  });

  test("empty-string sub → false (non-empty sub required)", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { sub: "" }))).toBe(false);
  });

  test("empty-string token → false", async () => {
    const { jwksJson } = await makeKeys();
    expect(await buildVerifier({ issuer: ISSUER, jwksJson }).verify("")).toBe(false);
  });

  test("expired within the 60s clock tolerance → true", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { expOffset: -30 }))).toBe(true);
  });

  test("no audience configured → token with any aud still accepted", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { aud: "somebody-else" }))).toBe(true);
  });

  test("unreachable JWKS url fails closed (no network fallback to accept)", async () => {
    const v = buildVerifier({ issuer: ISSUER, jwksUrl: "http://127.0.0.1:1/jwks.json" });
    expect(await v.verify("not-a-jwt")).toBe(false);
  });
});
