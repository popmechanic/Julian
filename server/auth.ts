// OIDC bearer verification for the Bun server. Keys come from the issuer's
// discovery document (jwks_uri), an explicit jwksUrl, or inline JWKS (tests).
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

export interface AuthConfig {
  issuer: string;
  audience?: string;
  jwksJson?: string; // test seam: inline JWKS, no network
  jwksUrl?: string; // explicit override; else derived from discovery
}

export interface Verifier {
  verify(token: string): Promise<boolean>;
}

export function buildVerifier(cfg: AuthConfig | null): Verifier {
  if (!cfg) {
    // No issuer configured = local dev; the app runs unlocked on this machine.
    return { verify: async () => true };
  }
  const config = cfg;

  let keySet: JWTVerifyGetKey | null = config.jwksJson
    ? createLocalJWKSet(JSON.parse(config.jwksJson))
    : null;

  async function keys(): Promise<JWTVerifyGetKey> {
    if (keySet) return keySet;
    let url = config.jwksUrl;
    if (!url) {
      const res = await fetch(new URL("/.well-known/openid-configuration", config.issuer));
      if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
      url = ((await res.json()) as { jwks_uri: string }).jwks_uri;
    }
    keySet = createRemoteJWKSet(new URL(url));
    return keySet;
  }

  return {
    async verify(token: string): Promise<boolean> {
      try {
        const { payload } = await jwtVerify(token, await keys(), {
          issuer: config.issuer,
          clockTolerance: 60,
          ...(config.audience ? { audience: config.audience } : {}),
        });
        return typeof payload.sub === "string" && payload.sub.length > 0;
      } catch (err) {
        console.error("[auth] token rejected:", (err as Error).message);
        return false; // fail closed — including discovery/JWKS fetch failures
      }
    },
  };
}
