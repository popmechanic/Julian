// The gate's bindings. Everything under "secrets" arrives as a worker secret
// (`wrangler secret put`); everything else is a plain var from wrangler.toml.
export interface Env {
  GOVERNOR: DurableObjectNamespace;
  REGISTRAR: DurableObjectNamespace;

  // The package pin: one KV key (package-types PIN_KEY) holding the content
  // sha every package read is served from. Written only by /pin-bump.
  PIN: KVNamespace;

  // The gate's own `/mcp` URL — RFC 8707 `resource` on the authcode flow is
  // valid only for this exact value.
  MCP_RESOURCE_URL: string;

  // Pocket ID — the approver's login, and (until the window closes) the legacy
  // bearer identity.
  OIDC_ISSUER: string;
  OIDC_JWKS_URL: string;
  OIDC_JWKS_JSON?: string; // test seam: inline JWKS instead of remote fetch
  OIDC_AUDIENCE?: string;

  // The gate's own face.
  APPROVER_SUBS: string;      // comma-separated Pocket ID subs; empty refuses every approval
  GATE_CLIENT_ID: string;     // Pocket ID client for the approval login
  GATE_REDIRECT_URI: string;  // must match the client's registered callback
  PUBLIC_URL: string;         // the gate's own origin, as a door sees it
  // Permanently unset since d642e5a deleted it from wrangler.toml (the sunset):
  // lease-auth's legacy arm reads it and fails closed on the missing value
  // (Date.parse(undefined ?? '') → NaN → 401 WINDOW_CLOSED). Optional so the
  // type tells the truth; deleting the legacy arm itself is its own decision.
  LEGACY_WINDOW_END?: string;

  PACKAGE_RAW_BASE: string;   // raw content root, e.g. https://raw.githubusercontent.com/popmechanic/Julian
  PIN_COMPARE_BASE: string;   // branch-membership proof root, e.g. https://api.github.com/repos/popmechanic/Julian/compare/main...
  GITHUB_TOKEN?: string;      // optional: authenticates the pin-bump compare call (rate-limit ceiling); never logged

  // Stream authority.
  STREAM_SUBS: string;        // sub=principal comma-separated map
  APP_ORIGINS: string;        // comma-separated exact origins

  // The sync worker binding — minted leases verify introspection with this secret.
  SYNC: { fetch(input: string | Request, init?: RequestInit): Promise<Response> };

  // Secrets.
  SESSION_SECRET: string;     // signs the approver session cookie
  INTROSPECT_SECRET: string;  // shared with julian-sync for POST /introspect
  SYNC_READ_SECRET: string;   // shared with julian-sync for internal read routes
  BREAKGLASS_SECRET: string;  // the CLI's way into /leases when no browser will do
  AGENTMAIL_API_KEY: string;

  // Rate limiter for exchange endpoint (optional — absence is a tested fail-open).
  EXCHANGE_RL?: { limit(opts: { key: string }): Promise<{ success: boolean }> };

  AGENTMAIL_INBOX_ID: string;

  /** When set, the worker answers 410 to everything — the sunset signpost. */
  MOVED_TO?: string;
}
