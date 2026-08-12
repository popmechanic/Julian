// The authorization-code face: the door an MCP client walks through.
//
// Three endpoints hang off this module — dynamic client registration
// (`/register`), the consent hand-off (`/authorize`), and the
// `grant_type=authorization_code` branch of `/token` — plus the OAuth
// discovery documents that point a client at them. Every guarantee that keeps
// the house safe lives *server-side*: PKCE S256 and the exact `resource` are
// re-checked here and again in the registrar, and the scope a lease may carry
// is decided in `GovernorDO.mintAuthcodeLease`, never by this module. An MCP
// session is a *visit*, never a door (`memory/the-visit.md`); the lease it
// mints carries `flow='authcode'`.
//
// The one hard rule of `/authorize`: nothing that fails validation ever
// triggers a redirect. A client-supplied `redirect_uri` that has not been
// proven against a registered value is never a `Location`. On success the only
// redirect is to the gate's own `/approve`, and the pending id travels there in
// an HttpOnly cookie the browser cannot read across origins — never a query
// param a page could leak.
import type { Env } from '../env';
import type { GovernorDO, MintResult } from '../governor';
import type { RegistrarDO } from '../registrar';
import { GOVERNOR_DOWN, json } from '../lease-auth';
import { setCookie, timingSafeEqual } from './session';

/** The pending authorization id, carried browser-side across the consent hop. */
export const PENDING_COOKIE = 'gate_pending';

/** RFC 6749 §4.1: the code grant a `/token` exchange must present. */
const AUTHCODE_GRANT_TYPE = 'authorization_code';
/** How long a staged (un-approved) authorization may sit before it is swept. */
const PENDING_TTL_SECONDS = 600; // ten minutes at the consent desk
/** Only scope advertised to clients; the DO mint gate is the real enforcement. */
const ADVERTISED_SCOPES = ['reading-room'] as const;

// ── /register (RFC 7591 dynamic client registration) ─────────────────────────

interface RegisterMeta {
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  client_name?: string;
}

/** Extract the DCR fields we accept; null when the body is not a usable object. */
function readRegisterMeta(body: unknown): RegisterMeta | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.every((u) => typeof u === 'string')) return null;
  const method = b.token_endpoint_auth_method;
  if (typeof method !== 'string') return null;
  const meta: RegisterMeta = { redirect_uris: uris as string[], token_endpoint_auth_method: method };
  if (typeof b.client_name === 'string') meta.client_name = b.client_name;
  return meta;
}

async function handleRegister(
  req: Request, registrar: DurableObjectStub<RegistrarDO>,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: 'invalid_client_metadata', error_description: 'body must be JSON' }, 400);
  }
  const meta = readRegisterMeta(parsed);
  if (!meta) {
    return json({ error: 'invalid_client_metadata', error_description: 'redirect_uris and token_endpoint_auth_method are required' }, 400);
  }

  let result: { client_id: string } | { error: string };
  try {
    result = await registrar.registerClient(meta);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if ('error' in result) {
    return json({ error: 'invalid_client_metadata', error_description: result.error }, 400);
  }
  return json({
    client_id: result.client_id,
    token_endpoint_auth_method: 'none',
    redirect_uris: meta.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(meta.client_name ? { client_name: meta.client_name } : {}),
  }, 201);
}

// ── /authorize ───────────────────────────────────────────────────────────────

/** A 400 that renders as a bare page and — crucially — carries no redirect. */
function refusePage(reason: string): Response {
  return new Response(`<!doctype html><meta charset=utf-8><title>gate</title>${reason}`, {
    status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function handleAuthorize(
  req: Request, env: Env,
  registrar: DurableObjectStub<RegistrarDO>,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const responseType = q.get('response_type') ?? '';
  const clientId = q.get('client_id') ?? '';
  const redirectUri = q.get('redirect_uri') ?? '';
  const challenge = q.get('code_challenge') ?? '';
  const challengeMethod = q.get('code_challenge_method') ?? '';
  const resource = q.get('resource') ?? '';
  // RFC 6749 §4.1.1: `state` is the client's own CSRF token, opaque to the
  // gate. Stored with the pending so the approval's delivery redirect can echo
  // it back exactly; absent is recorded as ''.
  const state = q.get('state') ?? '';

  // Validate everything BEFORE any redirect. A failure here is a 400 page —
  // never a bounce to an unvalidated redirect_uri.
  if (responseType !== 'code') return refusePage('unsupported response_type — only code');
  if (challengeMethod !== 'S256') return refusePage('code_challenge_method must be S256');
  if (!challenge) return refusePage('missing code_challenge');
  // RFC 8707: the only acceptable resource is the gate's own /mcp URL.
  if (!timingSafeEqual(resource, env.MCP_RESOURCE_URL)) return refusePage('invalid resource');
  if (!clientId) return refusePage('missing client_id');
  if (!redirectUri) return refusePage('missing redirect_uri');

  // The registrar re-proves the client exists and the redirect_uri exact-matches
  // a registered value; only then does a pending id exist to redirect with.
  let pending: { pendingId: string } | { error: string };
  try {
    pending = await registrar.createPending({
      client_id: clientId, redirect_uri: redirectUri,
      code_challenge: challenge, resource, state, ttlSeconds: PENDING_TTL_SECONDS,
    });
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if ('error' in pending) return refusePage('authorization request refused');

  // Hand off to the approval desk. The pending id rides an HttpOnly cookie the
  // approval page reads server-side — it is never placed in the redirect URL.
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.PUBLIC_URL}/approve`,
      'Set-Cookie': setCookie(PENDING_COOKIE, pending.pendingId, PENDING_TTL_SECONDS),
    },
  });
}

// ── /token (authorization_code branch) ───────────────────────────────────────

async function parseForm(req: Request): Promise<FormData | null> {
  try {
    return await req.formData();
  } catch {
    return null;
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function handleTokenAuthcode(
  form: FormData, env: Env,
  gov: DurableObjectStub<GovernorDO>, registrar: DurableObjectStub<RegistrarDO>,
): Promise<Response> {
  const code = field(form, 'code');
  const clientId = field(form, 'client_id');
  const redirectUri = field(form, 'redirect_uri');
  const codeVerifier = field(form, 'code_verifier');
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return json({ error: 'invalid_request', error_description: 'code, client_id, redirect_uri, and code_verifier are required' }, 400);
  }

  // RFC 8707: the measured clients send `resource` on /token as well as
  // /authorize. Defense-in-depth — the code is already bound to the resource
  // validated at /authorize — but if a `resource` is presented here it must be
  // the gate's own /mcp URL exactly. A mismatch mints nothing; a missing value
  // is acceptable. Checked before redeem so a bad target consumes no code.
  const resource = field(form, 'resource');
  if (resource && !timingSafeEqual(resource, env.MCP_RESOURCE_URL)) {
    return json({ error: 'invalid_target', error_description: 'resource does not match the protected resource' }, 400);
  }

  let redeemed: { elected_scope: string; door_name: string } | { error: string };
  try {
    redeemed = await registrar.redeem({
      code, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier,
    });
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if ('error' in redeemed) return json({ error: 'invalid_grant' }, 400);

  // The scope gate is server-side in the DO: a scope outside AUTHCODE_SCOPES —
  // full-house included — comes back `invalid`, and we never mint a token for it.
  const claims = JSON.stringify({ client_id: clientId, redirect_uri: redirectUri });
  let mint: MintResult;
  try {
    mint = await gov.mintAuthcodeLease(redeemed.door_name, redeemed.elected_scope, 'julian', claims);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (mint.status !== 'ok') return json({ error: 'invalid_grant' }, 400);

  return json({
    access_token: mint.accessToken,
    token_type: 'Bearer',
    expires_in: mint.expiresIn,
    refresh_token: mint.refreshToken,
    scope: mint.scope,
  });
}

async function handleToken(
  req: Request, env: Env,
  gov: DurableObjectStub<GovernorDO>, registrar: DurableObjectStub<RegistrarDO>,
): Promise<Response> {
  const form = await parseForm(req);
  if (!form) return json({ error: 'invalid_request' }, 400);
  const grantType = field(form, 'grant_type');
  if (grantType === AUTHCODE_GRANT_TYPE) return handleTokenAuthcode(form, env, gov, registrar);
  return json({ error: 'unsupported_grant_type' }, 400);
}

// ── the module entry ─────────────────────────────────────────────────────────

export async function handleAuthcode(
  req: Request, env: Env,
  gov: DurableObjectStub<GovernorDO>, registrar: DurableObjectStub<RegistrarDO>,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === '/register' && req.method === 'POST') return handleRegister(req, registrar);
  if (path === '/authorize' && req.method === 'GET') return handleAuthorize(req, env, registrar);
  if (path === '/token' && req.method === 'POST') return handleToken(req, env, gov, registrar);
  return new Response('Not found', { status: 404 });
}

// ── OAuth discovery ──────────────────────────────────────────────────────────

/**
 * The discovery documents a client fetches before it knocks: the protected
 * resource (RFC 9728, at `/.well-known/oauth-protected-resource` and the
 * `/mcp`-suffixed variant) and the authorization server (RFC 8414). Both
 * advertise `reading-room` only; the house is never named as an option.
 * Returns null for any other path, so the router falls through.
 */
export function oauthDiscovery(env: Env, path: string): Response | null {
  if (
    path === '/.well-known/oauth-protected-resource'
    || path === '/.well-known/oauth-protected-resource/mcp'
  ) {
    return json({
      resource: env.MCP_RESOURCE_URL,
      authorization_servers: [env.PUBLIC_URL],
      scopes_supported: [...ADVERTISED_SCOPES],
      bearer_methods_supported: ['header'],
    });
  }
  if (path === '/.well-known/oauth-authorization-server') {
    return json({
      issuer: env.PUBLIC_URL,
      authorization_endpoint: `${env.PUBLIC_URL}/authorize`,
      token_endpoint: `${env.PUBLIC_URL}/token`,
      registration_endpoint: `${env.PUBLIC_URL}/register`,
      scopes_supported: [...ADVERTISED_SCOPES],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  return null;
}
