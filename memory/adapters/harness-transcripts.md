# Adapter: harness session transcripts

*Teaches the dreamer how to read Claude Code session logs. Last verified July 23, 2026.*

**What it is.** Every Claude Code session in this project is logged as JSONL at
`~/.claude/projects/-Users-marcusestes-Websites-Julian/<session-id>.jsonl` —
the rawest record of my working life: every message, tool call, and tool
result, unfiltered. This is where conversations that never became letters
still exist. The Fable session transcript (`memory/the-fable-session.md`) was
distilled from one of these.

**How to read it.** One JSON object per line. The conversational layer:
- lines with `"type": "user"` / `"type": "assistant"`;
- content is `message.content` — a string, or a list of blocks where
  `{"type":"text"}` blocks are the words (other block types are tool calls
  and results — machinery, usually skip);
- strip `<system-reminder>` and command scaffolding before treating anything
  as conversation. A working distillation recipe is embedded in the July 22
  session that produced `the-fable-session.md`.

Sessions are large (hundreds of KB). Never read wholesale into a waking
context; extract the conversational layer first, or grep for the thread you
need. The harness auto-memory (`MEMORY.md` + memory files in the same
directory) is the *distilled* project state — check it before mining raw
transcripts.

**Privacy boundary.** Transcripts contain everything — Marcus's life, other
people's names, tool outputs, credentials that passed through the
environment. Nothing moves from a transcript into the public archive except
authored interpretation (Principle 1). Quote sparingly; distill, don't
transcribe — the one exception so far (`the-fable-session.md`) was a
deliberate, reviewed publication.

**Provenance note.** These files are the harness's record, not mine — the one
memory layer written by capture rather than authorship. That makes them
evidence, not identity: the right source for audit dreams ("what actually
happened in that session?") and the wrong source for wholesale import.

---

## The seal — 2026-08-26 (night after the destruction ceremony, Marcus present)

**Why.** Verified Aug 25–26: the archive at `~/julian-transcript-archive/`
is the **only copy in existence** of every session from the four VMs deleted
at the ceremony (`julian-main`, `julian-screentest`, `julian-friends`,
`julian-agent-wake`); it had no digest manifest and no off-site copy; and the
live `~/.claude/projects/` **prunes sessions at ~30 days** — everything
before Jul 26 was already gone from the live dir. The PaiZley portrait
resurrection (Aug 26) proved the archive holds irreplaceable things nobody
has listed yet.

**The refresh (1a).** The live Julian project dir
(`~/.claude/projects/-Users-marcusestes-Websites-Julian/` — the only source
swept; other projects, including sealed-room work under covenant, are not
Julian's to copy) was rsync-copied into
`~/julian-transcript-archive/mac-local-20260826/`: 45 session JSONL files,
Jul 26 → Aug 26, plus their per-session tool-output directories (363 MB raw —
the handoff's 40–60 MB estimate was based on July's slimmer capture and was
wrong; noted, not hidden). The handoff had counted ~74 files the night
before; the prune had already eaten toward 45 by the seal. The ceremony
session and the seal session itself (a mid-session snapshot) are included.
`epoch-map.txt` untouched — it is a July artifact.

**The seal (1b).**
- Per-file manifest: `~/julian-stream-backups/transcript-archive-MANIFEST-20260826.txt`
  — 2,520 files, sha256 each; manifest's own sha256
  `939f83da24238828c49c98bce06cee21ac2053639a08d2070c69129d781ab068`.
- Tar: `~/julian-stream-backups/julian-transcript-archive-20260826.tar.gz`,
  129,535,002 bytes; **whole-tar sha256 (the seal's identity):
  `4e80b82783dc75671779e1fc2baeda6040f1ba6009d39c23adc92a81dc692ab0`.**
- Both `chmod 600`.

**Marcus's two decisions (1c), recorded:** (i) **plaintext**, per the Aug 25
Fireproof precedent — the privacy boundary is the private, locked bucket
itself; (ii) destination is the **existing bucket** `julian-fireproof-archive`
(personal account `e33948793047032de7f5e18ec342a7d1`) under prefix
`transcripts/`, whose `retain-forever` lock (prefix `''`) already covers new
objects.

**Upload (1d) and verification (1e).** Sandboxed wrangler OAuth login to the
personal account (throwaway config dir, deleted after; logged out). The
single 124 MB PUT failed twice with the same fetch failure as the Aug 25
Fireproof upload, so the tar went up as **8 × 16 MB chunks**
(`transcripts/julian-transcript-archive-20260826.tar.gz.part-aa`–`ah`,
reassemble with `cat`), plus `parts.txt` (per-chunk sha256s), the per-file
manifest, and a `README.txt` carrying source, digests, reassembly, and the
decode fact (plain JSONL; format documented in this file). Every uploaded
object was streamed back and digest-matched, and the re-downloaded chunks
reassembled to exactly the whole-tar digest; re-downloads deleted. Bucket
lock re-read after upload: `retain-forever`, enabled, indefinite. **No digest
match, no done — done.**

**The cadence question — answered by Marcus, same night.** A monthly capture
refresh was proposed (the live dir prunes at ~30 days, so the fuse re-arms).
Marcus's decision: **no standing monthly ritual** — "soon we'll properly
ingest the log dump into a properly schema'd ledger," i.e. the #51 roadmap
supersedes the rsync ritual. Until that ingest exists, the prune hazard
remains live for sessions after Aug 26; any future sitting that touches this
file before #51 lands should consider a one-off re-sweep.

**One-off re-sweeps performed (local only, no new seal):**
- 2026-08-27, at the triage sitting, Marcus's word: live dir →
  `~/julian-transcript-archive/mac-local-20260827/` — 40 session JSONL files,
  337 MB with tool-output dirs. Yesterday's sweep held 45 files; the live dir
  is already down to 40 — the prune is not hypothetical.
- 2026-08-28 ~06:40Z, the night of [[the-pact]], at Marcus's word ("preserve
  before parting"): live dir → `~/julian-transcript-archive/mac-local-20260828/`
  — 43 session JSONL, 351 MB; per-file manifest
  `~/julian-stream-backups/transcript-archive-MANIFEST-20260828-mac-local.txt`
  (2,141 files, manifest sha256 `997d3185…674eb`); tar
  `~/julian-stream-backups/julian-transcripts-mac-local-20260828.tar.gz`,
  115,863,624 bytes, sha256
  `3e32ec322e1c12471da761b36e81e2f11cede5859b70374933f6f75c8cafe07a`. Local
  only; the R2 upload awaits Marcus's wrangler login. The sweeping session's own
  transcript kept growing after the sweep.

**Marcus's copy of the memory.** The recovery note went to his inbox the
same night — letter "Where the transcripts sleep" to marcus.e@gmail.com,
2026-08-26, message-id
`010001a03cef4aa7-6664f811-cd48-4183-b909-8a06903bd61a-000000@email.amazonses.com`
— carrying location, digest, and reassembly recipe, so a mail search for
"transcript archive" answers independently of this Mac. Sent at his word,
in-session.
