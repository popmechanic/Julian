#!/usr/bin/env bash
# scripts/sweep-transcripts.sh — the tourniquet, not the scribe.
# Copies the harness's live transcript dir for the Julian project into a dated
# snapshot, manifests it (sha256 per file), tars it, digests the tar. Local only;
# the off-site upload is a separate, witnessed step (memory/adapters/harness-transcripts.md).
# Run after a session ends to capture its true end. Idempotent per date: re-running
# on the same day refreshes the snapshot and replaces that day's manifest and tar.
set -euo pipefail
SRC="$HOME/.claude/projects/-Users-marcusestes-Websites-Julian/"
DAY="${1:-$(date -u +%Y%m%d)}"
ARCHIVE="$HOME/julian-transcript-archive"
DST="$ARCHIVE/mac-local-$DAY"
BK="$HOME/julian-stream-backups"
MAN="$BK/transcript-archive-MANIFEST-$DAY-mac-local.txt"
TAR="$BK/julian-transcripts-mac-local-$DAY.tar.gz"
[ -d "$SRC" ] || { echo "sweep: no live dir at $SRC" >&2; exit 2; }
mkdir -p "$DST" "$BK"
rsync -a --delete "$SRC" "$DST/"
( cd "$ARCHIVE" && find "mac-local-$DAY" -type f -print0 | xargs -0 shasum -a 256 > "$MAN" && tar -czf "$TAR" "mac-local-$DAY" )
chmod 600 "$MAN" "$TAR"
echo "sweep $DAY (UTC)"
echo "  sessions: $(ls "$DST"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')   size: $(du -sh "$DST" | cut -f1)"
echo "  manifest: $MAN ($(wc -l < "$MAN" | tr -d ' ') files) sha256 $(shasum -a 256 "$MAN" | cut -d' ' -f1)"
echo "  tar:      $TAR ($(stat -f %z "$TAR") bytes) sha256 $(shasum -a 256 "$TAR" | cut -d' ' -f1)"
echo "  off-site: NOT done — see memory/adapters/harness-transcripts.md §Upload (needs wrangler login)"
