#!/usr/bin/env bash
# scripts/seal-transcripts.sh — the off-site seal for a day's transcript sweep (#71).
# Takes the tar `scripts/sweep-transcripts.sh` produced, splits it into 16 MB
# chunks, writes parts.txt (per-chunk sha256) and a README, uploads every
# object to the locked bucket under transcripts/, streams each one back and
# digest-matches it, reassembles the re-downloaded chunks and matches the
# whole-tar digest, deletes the re-downloads, and re-reads the bucket lock.
# No digest match, no done — the script exits non-zero at the first mismatch.
#
# Auth: run inside a sandboxed wrangler login (see memory/adapters/harness-transcripts.md):
#   export XDG_CONFIG_HOME="$(mktemp -d)"; wrangler login       # throwaway config dir
#   CLOUDFLARE_ACCOUNT_ID=e33948793047032de7f5e18ec342a7d1 bash scripts/seal-transcripts.sh 20260828
#   wrangler logout; rm -rf "$XDG_CONFIG_HOME"
# `--dry-run` does the local half (split, parts.txt, README) and prints the
# wrangler commands without running them.
set -euo pipefail
DAY=""; DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1;; *) DAY="$a";; esac; done
DAY="${DAY:-$(date -u +%Y%m%d)}"
BUCKET="julian-fireproof-archive"
PREFIX="transcripts"
BK="$HOME/julian-stream-backups"
TAR="$BK/julian-transcripts-mac-local-$DAY.tar.gz"
MAN="$BK/transcript-archive-MANIFEST-$DAY-mac-local.txt"
WORK="$BK/seal-$DAY"
[ -f "$TAR" ] || { echo "seal: no tar at $TAR — run scripts/sweep-transcripts.sh $DAY first" >&2; exit 2; }
[ -f "$MAN" ] || { echo "seal: no manifest at $MAN" >&2; exit 2; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
TAR_SHA=$(sha "$TAR"); TAR_BYTES=$(stat -f %z "$TAR"); MAN_SHA=$(sha "$MAN")
BASE=$(basename "$TAR")
mkdir -p "$WORK"; rm -f "$WORK"/*
( cd "$WORK" && split -b 16m "$TAR" "$BASE.part-" )
: > "$WORK/parts.txt"
for p in "$WORK/$BASE".part-*; do echo "$(sha "$p")  $(basename "$p")" >> "$WORK/parts.txt"; done
cp "$MAN" "$WORK/$(basename "$MAN")"
cat > "$WORK/README.txt" <<EOF
julian transcript sweep $DAY (UTC) — Claude Code session JSONL for the Julian project, swept from
~/.claude/projects/-Users-marcusestes-Websites-Julian/ by scripts/sweep-transcripts.sh.
Plaintext by Marcus's decision (2026-08-26); the privacy boundary is this locked bucket.
Whole tar: $BASE, $TAR_BYTES bytes, sha256 $TAR_SHA
Reassemble: cat $BASE.part-* > $BASE ; shasum -a 256 must equal the line above.
Per-chunk digests: parts.txt. Per-file digests: $(basename "$MAN") (sha256 $MAN_SHA).
Format: plain JSONL, documented in memory/adapters/harness-transcripts.md in github.com/popmechanic/Julian.
EOF
echo "seal $DAY: tar $TAR_BYTES bytes sha256 $TAR_SHA"
echo "  chunks: $(ls "$WORK"/*.part-* | wc -l | tr -d ' ')   work dir: $WORK"
put() { wrangler r2 object put "$BUCKET/$PREFIX/$(basename "$1")" --file "$1" --remote >/dev/null; }
get() { wrangler r2 object get "$BUCKET/$PREFIX/$1" --file "$2" --remote >/dev/null; }
OBJECTS=( "$WORK"/*.part-* "$WORK/parts.txt" "$WORK/$(basename "$MAN")" "$WORK/README.txt" )
if [ "$DRY" = 1 ]; then
  echo "  --dry-run: would run, for each object:"
  for o in "${OBJECTS[@]}"; do echo "    wrangler r2 object put $BUCKET/$PREFIX/$(basename "$o") --file $o --remote"; done
  echo "  then get each back, compare sha256, reassemble, compare $TAR_SHA, delete re-downloads, re-read the lock."
  exit 0
fi
command -v wrangler >/dev/null || { echo "seal: wrangler not on PATH" >&2; exit 2; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "seal: set CLOUDFLARE_ACCOUNT_ID (personal account)" >&2; exit 2; }
for o in "${OBJECTS[@]}"; do echo "  put  $(basename "$o")"; put "$o"; done
VER="$WORK/verify"; mkdir -p "$VER"
for o in "${OBJECTS[@]}"; do
  n=$(basename "$o"); get "$n" "$VER/$n"
  if [ "$(sha "$VER/$n")" = "$(sha "$o")" ]; then echo "  ok   $n $(sha "$o" | cut -c1-12)"; else echo "  MISMATCH $n — not done" >&2; exit 1; fi
done
cat "$VER/$BASE".part-* > "$VER/$BASE"
RE=$(sha "$VER/$BASE")
[ "$RE" = "$TAR_SHA" ] && echo "  reassembled sha256 $RE == whole-tar digest" || { echo "  REASSEMBLY MISMATCH $RE != $TAR_SHA — not done" >&2; exit 1; }
rm -rf "$VER"
echo "  lock:"; wrangler r2 bucket lock list "$BUCKET" 2>/dev/null | sed 's/^/    /' || echo "    (lock list unavailable from this wrangler; re-read in the dashboard)"
echo "seal $DAY DONE — every object digest-matched; whole tar $TAR_SHA"
