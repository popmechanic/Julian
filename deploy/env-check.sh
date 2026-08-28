#!/usr/bin/env bash
# deploy/env-check.sh <path-to-.env> — print the VALUE of every known-host
# variable and judge it, instead of reporting presence (#55). An old-house URL
# passes a presence check and bakes a bundle that syncs nowhere; the value is
# the only thing worth checking. Secrets are never printed: only the keys in
# the two tables below are read.
#
# Exit 0: every line OK/present. Exit 1: any WRONG, MISSING, or DUPLICATE.
# Exit 2: the file cannot be read.
set -u
f="${1:-}"
if [ -z "$f" ] || [ ! -r "$f" ]; then
  echo "env-check: cannot read '${f:-<no path>}' (no such file)" >&2
  exit 2
fi

# key=expected-host — the scheme may be https:// or wss://, nothing else.
HOSTS="VITE_OIDC_ISSUER=souls.exe.xyz
VITE_SYNC_URL=sync.julian.soul.store
VITE_GATE_URL=gate.julian.soul.store
BROKER_URL=gate.julian.soul.store"
# per-instance values: presence only, value printed so a human can see it.
PRESENT="VITE_OIDC_CLIENT_ID"

status=0
value_of() { grep -E "^$1=" "$f" | tail -n 1 | cut -d= -f2- | tr -d '\r'; }
count_of() { grep -cE "^$1=" "$f"; }

check_dup() {
  local k="$1" n
  n=$(count_of "$k")
  if [ "$n" -gt 1 ]; then echo "$k DUPLICATE ($n lines; the last wins)"; status=1; fi
}

while IFS='=' read -r k host; do
  [ -z "$k" ] && continue
  check_dup "$k"
  n=$(count_of "$k")
  if [ "$n" -eq 0 ]; then echo "$k MISSING"; status=1; continue; fi
  v=$(value_of "$k")
  case "$v" in
    "https://$host"|"https://$host/"|"wss://$host"|"wss://$host/") echo "$k=$v OK" ;;
    *) echo "$k=$v WRONG (expected host $host)"; status=1 ;;
  esac
done <<< "$HOSTS"

for k in $PRESENT; do
  check_dup "$k"
  n=$(count_of "$k")
  if [ "$n" -eq 0 ]; then echo "$k MISSING"; status=1; continue; fi
  echo "$k=$(value_of "$k") present"
done

exit $status
