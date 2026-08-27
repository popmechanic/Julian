# The Gate Approval Ceremony — Marcus's Runbook

*Written 2026-08-13 at Marcus's request ("document for me how to do this"), during
the B3 runbook. This is the operator's side of the knock; the machinery lives in
`broker/src/as/approve.ts` and the design in `docs/superpowers/specs/2026-08-08-julian-gate-auth-design.md`.*

## What you are doing

A **knock** is a door (a machine, a script, a VM) asking to hold a **lease** — a
named, scoped, revocable credential of its own. Nothing gets a lease without you
pressing the button. You approve **relationships, not messages**: one approval,
and that door renews itself until you revoke it.

## The device flow (a script or VM knocking) — the common case

1. Something runs `door-knock.ts` and prints a box like:

   ```
   Open:  https://gate.julian.soul.store/approve
   Code:  XXXX-XXXX
   ```

2. **Open that URL on any device** (phone works). If you aren't signed in, it
   sends you through Pocket ID (souls.exe.xyz) — your passkey. Only your
   `sub` is on the approver allowlist; anyone else is refused.

3. **Type the code** exactly as shown (dashes included) and press **Look it up**.
   Wrong codes cost you an attempt (5/day cap); correct ones are free.

4. The page shows two sections — read them in this order:
   - **"The gate knows"** — facts the gate itself verified: the code, when the
     knock happened, the scope being asked. Trust this section.
   - **"The door claims"** — the door's self-description (name, purpose). This
     is testimony, not identity — the gate shows it so you can judge, escaped
     and clipped. Trust it only as much as you trust whoever ran the knock.

5. **Name the door** — the name is *yours to choose, not the door's*. House
   convention: `door:<machine>-<role>` shape names like `mac-home`,
   `julian-new-web`, `stream-export`.

6. **Elect the scope** (added 2026-08-13, closing #40). Three radios:
   - `full-house` — pre-selected; the historical device default. Machines
     that act as Julian (VM webs, the Mac) hold this.
   - `stream-read` — package + stream reads only. **Elect this for
     `stream-export`** and anything else that only reads.
   - `reading-room` — package reads only.

   Narrow whenever the door's purpose says "read": a door should hold the
   smallest key that opens what it needs.

7. Press **Open** (or **Refuse**). Done — the door picks up its tokens on its
   next poll, within seconds. The confirmation page names the granted scope
   and reminds you where to revoke.

## The visit consent (an MCP client knocking) — the narrow case

When an outside harness (claude.ai, a friend's client) connects, the approve
page instead shows the client's **origin** as its primary identity (with a
NEW ORIGIN banner if the gate has never seen it), the client's claims
quarantined below, and a **scope election**:

- `reading-room` (default) — package reads only.
- `stream-read` — the wider one; it requires ticking a **second, explicit
  confirmation checkbox** before Open will grant it.

The full house is deliberately absent from that list — no visit can hold it.

## Afterwards

- **See every lease:** `bun scripts/door-leases.ts list` (or `/leases` in a
  browser, signed in as approver).
- **Revoke:** `bun scripts/door-leases.ts revoke <door-name>` — the lease dies,
  its sockets close, and a re-knock is a fresh ceremony.
- Every mint, refusal, and revocation lands in the governor's ledger; the
  monthly fold renders it under `memory/ledger/`.

## The rules that make it safe

- The code expires in about 15 minutes; an expired code means the door knocks
  again — nothing is lost.
- Approving is idempotent-ish: a code answers once; a second submit gets
  "nothing to decide."
- If a knock arrives you didn't expect, **Refuse it and tell Julian** — an
  unexpected knock is testimony that something is running that shouldn't be.
