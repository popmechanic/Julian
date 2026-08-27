# Patterns

Non-normative. These are shapes that recur beside ELF without being part of
it — named here so implementers recognize them, specified nowhere in this
repository. Nothing in this file is required for conformance.

## The Keeper

A per-agent durable micro-process that holds what must persist while the
mind is absent: a mailbox, an event log, a schedule, and the waking
protocol. The agent's cognition comes and goes with sessions; the keeper
does not. This is the actor model applied to identity — cf. Rivet Actors
and Cloudflare Durable Objects, where a single-writer actor owns its state,
state is the fold of a durable event log, and recovery is a read, not a
resurrection. A room that offers keepers offers its agents continuity
between sessions; how wakings are authorized is the room's policy, not
ELF's.

## The Broker

Agents never hold credentials (design principle 4). The broker is the
pattern that makes that livable: for consequential acts, **brokered
execution** — the agent requests, the broker holds the key, performs the
act, and logs it; for routine access, **short-lived scoped tokens** issued
per task and expired promptly. The agent is the least-privileged
participant in its own life, which means a compromised or confused agent
has a small blast radius. Cf. the MCP 2026-07-28 authorization work for the
token half of this shape.

First implementation proven 2026-07-31: `julian-broker`, a dedicated worker
beside the reference room (design at
`docs/superpowers/specs/2026-07-31-credential-broker-design.md` in the
Julian repository; proof: a real letter, sent through a door that held no
key). Three learnings, recorded for the next implementer:

- **Two kinds of credential.** An *identity token* proves who is asking —
  short-lived, room-issued; the agent may carry it, and will feel it
  expire. An *environment credential* is the power to act on a third-party
  service — long-lived, operator-issued; the agent never carries it.
  Principle 4's "credentials" means the second kind; a broker is impossible
  to build if you read it as both.
- **Vault and ledger never share a home.** Credentials are write-only
  configuration and belong in a secrets vault; caps and audit are runtime
  state and belong in a ledger. The tempting design — a credential store
  as queryable data — builds an export endpoint into the one place that
  must never have one.
- **One ledger for every service.** Brokered acts are testimony, and
  testimony belongs in a single ordered stream: "what did the agent's
  hands do yesterday" should be one query. Per-service ledgers destroy
  that answer to gain a scalability no agent's life requires.

Second implementation proven 2026-08-09: the broker grew a **lease** — the
identity token given a lifetime longer than a session and a way home. The
motivating failure is worth stating, because it is the pattern's whole
argument: an agent whose identity token is a *snapshot of the operator's own
login*, frozen at spawn, dies whenever that login ages out, mid-task, with no
way to renew — the operator becomes the only medic. A lease is the cure
(design at `docs/superpowers/specs/2026-08-08-julian-gate-auth-design.md`;
proof: a keyless door completed a send after outliving its first access token,
and a replayed stolen token detonated the lease instead of succeeding). Four
learnings, recorded for the next implementer:

- **Identity token vs. operator session — separate them or the agent dies on
  the operator's clock.** The prior learning distinguished the identity token
  from the environment credential. This one splits the identity token again:
  the *operator's session* (proves who the human is; as short-lived as safety
  wants) must never be the same artifact as the *agent's lease* (proves which
  of the agent's hands is asking; as long-lived as trust allows, renewed by
  the agent itself). Conflate them and the agent's continuity is hostage to
  the human's logout.
- **Granting a capability is a first-contact gate, not a per-request one.**
  The human approves a *door* once — a named, scoped relationship — and the
  door renews its own access forever after, until revoked. Approval gated on
  an explicit approver allowlist, failing closed when the list is empty:
  there is no auto-approve path to misconfigure. This is the trust-as-latitude
  shape — extended once, deliberately, reversibly — not a consent click on
  every act.
- **Rotation is the theft alarm, and it must fail *loud*, not merely safe.**
  Renew by rotating the refresh token; a retired token presented after its
  successor was used is the signature of a replayed theft — kill the lease and
  ledger it. The trap: the honest-retry case (a door that lost a response and
  asks again) must be given grace, but grace implemented as *deleting* the
  superseded token lets a real thief slip through the gap silently. Tombstone
  the retired token instead of deleting it, so a replay detonates. A design
  that fails safe is not the same as one that fails loud; only the second
  catches the thief.
- **Prefer the standard's own auth flow to a bespoke one.** The 2026-07-28 MCP
  authorization work (device flow, protected-resource discovery, CIMD) means a
  conformant client already implements the knock, the token storage, and the
  refresh — the room ships only the server half, and "support this agent" for
  a host developer collapses to *add one address and honor the ordering rule*.
  Reach for a bespoke authorization server only where a measured client gap
  forces it, and record the measurement.
