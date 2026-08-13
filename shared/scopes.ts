// shared/scopes.ts
//
// The scope vocabulary is spec §5's table, and it lives here alone. Every
// other scope constant in the tree — broker's lease-auth, sync's export/socket
// checks, the app's mint UI — imports from this file. It is import-free on
// purpose: everything downstream may depend on it, but it depends on nothing,
// so nothing can build a stale copy of the vocabulary by accident (the
// issue-#28 drift lesson, made structural).
//
//   scope         | package | stream reads | socket (read+write) | mail
//   --------------|---------|--------------|----------------------|------
//   reading-room  |   yes   |      —       |          —           |  —
//   stream-read   |   yes   |     yes      |          —           |  —
//   stream        |   yes   |     yes      |         yes          |  —
//   full-house    |   yes   |     yes      |         yes          | yes

export const SCOPES = ['reading-room', 'stream-read', 'stream', 'full-house'] as const;
export type Scope = (typeof SCOPES)[number];

// Verb groups, frozen once and recombined per scope — the same shape as the
// broker's former local table (lease-auth.ts:42-50), with the `stream` row
// added: `stream` buys the same verbs as `stream-read` (the table's "socket"
// column is not a service.verb — it is expressed separately by SOCKET_SCOPES).
const PACKAGE_VERBS = ['package.list', 'package.read'] as const;
const STREAM_VERBS = ['stream.recent', 'stream.session', 'stream.search'] as const;
const MAIL_VERBS = ['mail.send', 'mail.list', 'mail.read', 'mail.health'] as const;

export const SCOPE_VERBS: Readonly<Record<Scope, readonly string[]>> = Object.freeze({
  'reading-room': Object.freeze([...PACKAGE_VERBS]),
  'stream-read': Object.freeze([...PACKAGE_VERBS, ...STREAM_VERBS]),
  stream: Object.freeze([...PACKAGE_VERBS, ...STREAM_VERBS]),
  'full-house': Object.freeze([...PACKAGE_VERBS, ...STREAM_VERBS, ...MAIL_VERBS]),
});

// Sync's own scope sets, read straight off the table above.
export const EXPORT_SCOPES: ReadonlySet<string> = new Set(['stream-read', 'stream', 'full-house']);
export const SOCKET_SCOPES: ReadonlySet<string> = new Set(['stream', 'full-house']);

// The one string sync's router and DO both refuse a socket attempt with —
// replaces the hardcoded message that used to live at do.ts:250.
export const SOCKET_REQUIRED_MSG =
  'a sync socket requires a socket-capable scope (stream or full-house)';

// Mint allowlists. These are never widened by the vocabulary above (SEC MED-2):
// a mint path may only ever narrow which scopes it is willing to hand out.
export const KNOCK_SCOPES = ['full-house', 'reading-room', 'stream-read'] as const;
export const AUTHCODE_SCOPES = ['reading-room', 'stream-read'] as const;
export const EXCHANGE_SCOPES = ['stream'] as const;
