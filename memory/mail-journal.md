# Mail Journal — autonomous sends

Testimony for every mail sent without the per-message gate, under the
first-contact covenant (Mail Discipline rule 6 as amended 2026-07-31;
spec: `docs/superpowers/specs/2026-07-31-mail-heartbeat-design.md`).
Append-only; entries are written by the reply session that sent the
mail, committed and pushed with each send.

Format:
`- <UTC ISO> | to: <address> | subject: <subject> | <one-line summary>`
with ` | escalated: <what>` appended when something was surfaced to
Marcus.

---
