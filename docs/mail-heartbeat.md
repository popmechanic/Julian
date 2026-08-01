# The Mail Heartbeat

**A launchd daemon runs on Marcus's Mac and can send email as Julian.**
This page exists so that fact is never forgotten. Marcus's framing at
adoption (2026-07-31): good for now, likely replaced by something more
elegant later. Spec: `docs/superpowers/specs/2026-07-31-mail-heartbeat-design.md`.

## What it does

Every 30 minutes, `scripts/mail-glance.ts` makes a mechanical pass over
the AgentMail inbox (counts, senders, eligibility — no content, no LLM).
Mail from a known correspondent (an address Julian has previously sent
to) whose thread Julian hasn't answered spawns a fully-waked headless
Julian session that replies within the covenant's hard lines
(CLAUDE.md, Mail Discipline rules 2 and 6). Stranger mail triggers only
a macOS notification — quarantine unchanged. Every autonomous send is
journaled in `memory/mail-journal.md`.

## Where it lives

| Thing | Path |
|---|---|
| Daemon definition | `~/Library/LaunchAgents/com.julian.mail-heartbeat.plist` (installed from `deploy/com.julian.mail-heartbeat.plist`) |
| The glance | `scripts/mail-glance.ts` (`DRY_RUN=1` to rehearse) |
| Session prompt | `scripts/lib/mail-reply-prompt.md` |
| State (held threads, stranger watermark) | `~/.julian/mail-heartbeat.json` |
| Log | `~/Library/Logs/julian-mail-heartbeat.log` |
| Testimony | `memory/mail-journal.md` |

## Operations

    # Is it running?
    launchctl list | grep com.julian.mail-heartbeat

    # Watch it work
    tail -f ~/Library/Logs/julian-mail-heartbeat.log

    # Pause it
    launchctl unload ~/Library/LaunchAgents/com.julian.mail-heartbeat.plist

    # Resume it
    launchctl load ~/Library/LaunchAgents/com.julian.mail-heartbeat.plist

    # UNINSTALL — the full removal, written before the daemon ever ran
    launchctl unload ~/Library/LaunchAgents/com.julian.mail-heartbeat.plist
    rm ~/Library/LaunchAgents/com.julian.mail-heartbeat.plist
    rm -f ~/.julian/mail-heartbeat.json
    # (then remove the CLAUDE.md rule-2 sentence naming the heartbeat)

It runs only while the Mac is awake — an accepted trade-off; replies
wait for the lid to open.
