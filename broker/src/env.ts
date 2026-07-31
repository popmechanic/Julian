// The broker's bindings. AGENTMAIL_API_KEY arrives as a worker secret;
// everything else is a plain var from wrangler.toml.
export interface Env {
  GOVERNOR: DurableObjectNamespace;
  OIDC_ISSUER: string;
  OIDC_JWKS_URL: string;
  OIDC_JWKS_JSON?: string; // test seam: inline JWKS instead of remote fetch
  OIDC_AUDIENCE?: string;
  AGENTMAIL_API_KEY: string;
  AGENTMAIL_INBOX_ID: string;
}
