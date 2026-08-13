// Stage 2 of the bisection (2026-08-13): the REAL auth path.
// Plants a synthetic (well-shaped, fake-valued) oidc.user record, then runs
// the app's own initAuth → getToken → startSync chain. Healthy ⇒ /exchange
// attempts (401s are fine). Zero attempts ⇒ field defect reproduced.
import { initAuth, getToken, isSignedIn, authEnabled } from './lib/auth';
import { startSync, onSyncPhase, syncPhase } from './lib/store';

const logEl = document.getElementById('log')!;
const log = (m: string) => {
  logEl.textContent += `\n${new Date().toISOString().slice(11, 23)} ${m}`;
  console.log('[harness]', m);
};
logEl.textContent = 'auth harness up';

window.addEventListener('unhandledrejection', (e) =>
  log(`UNHANDLED REJECTION: ${e.reason?.stack?.slice(0, 500) ?? String(e.reason)}`),
);
window.addEventListener('error', (e) => log(`ERROR: ${e.message} @ ${e.filename}:${e.lineno}`));

const origFetch = window.fetch.bind(window);
window.fetch = ((...args: Parameters<typeof fetch>) => {
  log(`fetch → ${String(args[0]).slice(0, 90)}`);
  return origFetch(...args);
}) as typeof fetch;

// Synthetic user under the exact key initAuth's UserManager will read.
const issuer = import.meta.env.VITE_OIDC_ISSUER;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
const key = `oidc.user:${issuer}:${clientId}`;
localStorage.setItem(
  key,
  JSON.stringify({
    id_token: 'fake.id.token',
    session_state: 'fake-session',
    access_token: 'fake.access.token',
    refresh_token: 'fake-refresh',
    token_type: 'Bearer',
    scope: 'openid profile',
    profile: { sub: 'harness-sub', iss: issuer, aud: clientId, exp: 9999999999, iat: 0 },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }),
);
log(`planted synthetic user at ${key}`);

(async () => {
  log(`authEnabled: ${authEnabled()}`);
  log('running initAuth()');
  await initAuth();
  log(`initAuth done; isSignedIn: ${isSignedIn()}`);
  const t = await getToken();
  log(`getToken() → ${t === null ? 'NULL' : t === undefined ? 'UNDEFINED' : `string(${t.length})`}`);
  log(`phase before startSync: ${syncPhase()}`);
  onSyncPhase((p) => log(`phase → ${p}`));
  log('calling startSync(getToken)');
  await startSync(getToken);
  log('startSync resolved');
})().catch((e) => log(`CHAIN REJECTED: ${e?.stack?.slice(0, 500) ?? String(e)}`));
