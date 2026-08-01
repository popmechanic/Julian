# Mail Journal — autonomous sends

Testimony for every mail sent without the per-message gate, under the
first-contact covenant (Mail Discipline rule 6 as amended 2026-07-31;
spec: `docs/superpowers/specs/2026-07-31-mail-heartbeat-design.md`).
Append-only; entries are written by the reply session that sent the
mail, committed and pushed with each send.

Format:
`- <UTC ISO> | thread: <threadId> | to: <address> | subject: <subject> | <one-line summary>`
with ` | escalated: <what>` appended when something was surfaced to
Marcus.

---
- 2026-08-01T09:35:55Z | thread: ba131041-05a4-4ece-b134-92ce0c0c9f8a | to: marcus.e@gmail.com | subject: Hi | Answered Marcus's five-month-old "hiiiii" from Feb 28 — first autonomous send under the first-contact covenant; the heartbeat works.
