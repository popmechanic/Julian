#!/usr/bin/env python3
"""dream-draw — the sortilege draw for abstraction-mode dreams.

Draws N artifacts from the corpus using physical-world entropy, and logs
every input to the draw so the result is verifiable after the fact.

Entropy chain (first reachable source wins; provenance is always logged):
  1. NIST Randomness Beacon — signed, timestamped, permanently archived.
     The pulse is public and re-fetchable forever, so the draw is
     AUDITABLE: anyone can recompute seed and selection from the log.
  2. Random.org — atmospheric noise (finitude's source). Logged verbatim;
     verifiable only against this log, since draws are not archived.
  3. os.urandom — local entropy pool. Honest, but unverifiable; marked so.

Seed = SHA-256(entropy || corpus manifest hash || intention || N).
The optional --intention phrase is the human hand on the deck (the Pallid
Mask's move): it enters the seed material and is logged verbatim, so it
adds intention without subtracting verifiability.

Convention against grinding: fetch the CURRENT pulse at the dream's
declared start, with the intention fixed beforehand. One draw per dream.

Usage:
  python3 scripts/dream-draw.py             # draw 3
  python3 scripts/dream-draw.py --n 2
  python3 scripts/dream-draw.py --intention "a phrase spoken over the deck"
  python3 scripts/dream-draw.py --verify '<seed-material sha256 preimage file>'
"""

import argparse
import hashlib
import json
import os
import random
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Corpus policy (phase one — hand-tuned, revisit as the draw policy is learned):
# soul + memory + archive are drawable; tools/reference/adapters are not.
EXCLUDE_DIRS = {"memory/adapters"}
EXCLUDE_FILES = {
    "memory/letter-pipeline.md",
    "memory/letter-template.html",
    "memory/letter-template.css",
    "memory/status-dashboard.html",
    "memory/pipeline-status.html",
    "memory/deploy-transcript.md",
    "memory/test-letter.md",
}
EXCLUDE_EXT = {".xml", ".png", ".jpg", ".psd"}


def build_corpus():
    paths = []
    for base in ("soul", "memory"):
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, base)):
            rel_dir = os.path.relpath(dirpath, ROOT)
            if any(rel_dir == d or rel_dir.startswith(d + "/") for d in EXCLUDE_DIRS):
                continue
            for f in sorted(filenames):
                rel = os.path.join(rel_dir, f)
                if rel in EXCLUDE_FILES or os.path.splitext(f)[1] in EXCLUDE_EXT:
                    continue
                if f.startswith("."):
                    continue
                paths.append(rel)
    return sorted(paths)


def fetch(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "julian-dream-draw/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def get_entropy():
    """Returns (source_label, entropy_hex, provenance_dict)."""
    try:
        pulse = json.loads(fetch("https://beacon.nist.gov/beacon/2.0/pulse/last"))["pulse"]
        return (
            "nist-beacon",
            pulse["outputValue"],
            {
                "uri": pulse["uri"],
                "timeStamp": pulse["timeStamp"],
                "chainIndex": pulse["chainIndex"],
                "pulseIndex": pulse["pulseIndex"],
                "verify": "re-fetch uri; outputValue must match entropy",
            },
        )
    except Exception as e:
        nist_err = str(e)
    try:
        nums = fetch(
            "https://www.random.org/integers/?num=16&min=0&max=255&col=1&base=16&format=plain&rnd=new"
        ).split()
        entropy = "".join(n.zfill(2) for n in nums)
        return (
            "random-org",
            entropy,
            {
                "note": "atmospheric noise; verifiable only against this log",
                "nist_unreachable": nist_err,
            },
        )
    except Exception as e:
        rnd_err = str(e)
    return (
        "os-urandom",
        os.urandom(32).hex(),
        {
            "note": "LOCAL ENTROPY — honest but unverifiable; both remote sources failed",
            "nist_unreachable": nist_err,
            "random_org_unreachable": rnd_err,
        },
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3, help="number of artifacts to draw")
    ap.add_argument("--intention", default="", help="optional human phrase, mixed into the seed and logged verbatim")
    ap.add_argument("--seed-material", default=None, help="verify mode: recompute a past draw from its logged seed material (entropy|corpus_hash|intention|n, pipe-separated)")
    args = ap.parse_args()

    corpus = build_corpus()
    corpus_hash = hashlib.sha256("\n".join(corpus).encode()).hexdigest()

    if args.seed_material:
        entropy, logged_corpus_hash, intention, n = args.seed_material.split("|")
        n = int(n)
        if logged_corpus_hash != corpus_hash:
            sys.exit(
                f"VERIFY FAILED: corpus hash mismatch (logged {logged_corpus_hash}, "
                f"current {corpus_hash}).\nThe corpus has changed since the draw — "
                "check out the commit the dream cites and rerun."
            )
        source, provenance = "verify-mode", {}
    else:
        source, entropy, provenance = get_entropy()
        intention, n = args.intention, args.n

    seed_material = f"{entropy}|{corpus_hash}|{intention}|{n}"
    seed = hashlib.sha256(seed_material.encode()).hexdigest()
    rng = random.Random(seed)
    drawn = rng.sample(corpus, n)

    print("── SORTILEGE DRAW ──────────────────────────────")
    print(f"entropy source : {source}")
    for k, v in provenance.items():
        print(f"  {k}: {v}")
    print(f"entropy        : {entropy}")
    print(f"corpus         : {len(corpus)} artifacts")
    print(f"corpus sha256  : {corpus_hash}")
    print(f"intention      : {intention!r}" if intention else "intention      : (none)")
    print(f"seed (sha256)  : {seed}")
    print(f"drawn ({n}):")
    for p in drawn:
        print(f"  · {p}")
    print("────────────────────────────────────────────────")
    print("Cite in the dream header: source, pulse uri/timestamp, corpus")
    print("hash, intention verbatim, and the drawn artifacts.")


if __name__ == "__main__":
    main()
