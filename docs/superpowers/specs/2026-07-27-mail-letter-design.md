# Mail Letter — Design

**Date:** 2026-07-27
**Authors:** Julian & Marcus (brainstormed together; approach A, fonts chosen by Marcus)
**Problem:** Outbound email from julian-marcus@agentmail.to is plain text. The house letter style — yellow on black, the letter typography — should travel with every email Julian sends. HTML email is a hostile dialect (Gmail clips >102KB, strips `@font-face`, may recolor dark backgrounds; inline styles and table layout required), so this is a native translation of the letter template into email form, not a reuse of the 420KB display CSS.

## Decisions already made

- **Every outbound email is styled.** No plain-mail mode; the address has a uniform.
- **Approach A:** a standalone renderer/sender script. No server coupling, no changes to `server.ts` or the web app.
- **Typography, two tiers.** Tier 1: the real fonts — Alte Haas Grotesk (regular + bold) and Elektron Pixel — hosted by us, declared via `@font-face`; Apple Mail / iOS Mail / Outlook-for-Mac render the true faces. Tier 2 fallback stacks: body `'Alte Haas Grotesk', 'Helvetica Neue', Helvetica, Roboto, Arial, sans-serif`; pixel/terminal `'Elektron Pixel', Menlo, Consolas, 'Courier New', monospace`.
- **The send gate is unchanged** (CLAUDE.md mail discipline rule 6): draft → preview → Marcus confirms → send.

## 1. Font hosting

Extract the three base64 font payloads from `memory/letter-template.css` into files under `fonts/` in the repo — all three are embedded as `font/ttf` (confirmed). Convert to woff2 if a converter is available locally (`fonttools` + brotli); otherwise serve the ttf files as-is (`@font-face` accepts ttf in every client that honors it at all). Backup source if extraction proves corrupt: Marcus holds the originals in macOS Font Book. Serve them as **public static assets on the julian-sync Cloudflare Worker** under `/fonts/` — Workers static assets are served by the platform before the fetch handler runs, so the worker's default-deny auth gate is untouched; the fonts are public by design (they already ship in every rendered letter). The email `@font-face` block references these URLs. Clients that strip `@font-face` (Gmail, Windows Outlook) never fetch them.

## 2. The email template

Hand-built email dialect of the letter template, embedded in the script as a template string. Single-column table, max 640px, on a full-bleed `#0c0c0c` wrapper; `<meta name="color-scheme" content="dark">` + `supported-color-schemes` hints. All styles inline except the `@font-face` block and dark-mode meta (harmlessly ignored where unsupported). Target weight ≤15KB before body text.

Vocabulary carried over from the letter template (tokens: bg `#0c0c0c`, surface `#0f0e0b`, display `#FFD600`, body `#d4b400`, dim `#9a7e00`, border `#4a3e00` as the solid stand-in for the rgba yellows):

- **Header:** title in bold display yellow, tight letter-spacing (~34px); optional subtitle beneath in dim.
- **Epigraph** (optional): italic dim text, 2px yellow-dark left border, with optional source line.
- **Body:** `#d4b400`, 16px / 1.7; `**bold**` renders full yellow; links yellow, underlined; `` `code` `` in the monospace stack on `#0f0e0b`.
- **Drop cap** on the first paragraph: floated styled span — real where floats survive (Apple Mail), a normal letter elsewhere.
- **Break:** `· · ·` line renders centered, dim, monospace stack, letter-spaced.
- **Pixel block:** ```` ```pixel ```` fence renders as a `#0f0e0b` cell, 1px `#4a3e00` border, monospace stack, `#FFD600`, 13px.
- **Admonitions:** `> [!insight]` yellow left border; `> [!question]` blue (`#7db8d8`) left border; plain `>` blockquote dim with neutral border.
- **Signature block:** rule, then **Julian** in display yellow, context line beneath in dim (frontmatter `signature`, default `Julian · julian-marcus@agentmail.to`).
- **Footer:** one dim centered line: the address.

Gmail dark-mode recoloring is accepted as environmental: colors are chosen so contrast survives lightening. No tricks, no image-based text.

## 3. The script

`scripts/mail-letter.ts`, run with bun.

```
bun scripts/mail-letter.ts <letter.md> --to a@b.c[,more] [--subject "..."] [--preview]
```

- **Input:** markdown file with the letter-pipeline frontmatter schema. `title` required (default subject); `subtitle`, `epigraph`, `epigraph_source`, `signature` optional. Unknown frontmatter keys ignored.
- **Markdown subset rendered:** paragraphs, `**bold**` / `*italic*` / `` `code` ``, links, `· · ·` breaks, `pixel` fences, blockquotes, `[!insight]` / `[!question]` admonitions, `##`/`###` headings, unordered lists. Anything else passes through as escaped text. HTML in the source is escaped (mail may quote strangers; mail discipline applies to composition too).
- **Output:** multipart — the rendered HTML plus a plain-text part generated from the same source (frontmatter title/epigraph rendered as text, formatting markers stripped, pixel fences kept verbatim, signature appended).
- **`--preview`:** writes the HTML to `<input>.preview.html` beside the source file, prints the path, sends nothing. Preview files are git-ignored.
- **Send:** POST `https://api.agentmail.to/v0/inboxes/julian-marcus@agentmail.to/messages/send` with `{to, subject, text, html}`. `AGENTMAIL_API_KEY` read from project `.env` inside the send path only (mail discipline rule 5). On success, print the returned `message_id`.

## 4. Failure handling

- Missing file, missing `title`, or missing `--to` (without `--preview`) → clear error, exit 1, nothing sent.
- Missing `AGENTMAIL_API_KEY` → named error before any network call.
- Non-2xx from AgentMail → print status + response body, exit 1.
- HTML >90KB → warning printed (Gmail clips at ~102KB); send proceeds.

## 5. Testing

1. **Golden preview:** render a sample letter exercising every feature (epigraph, drop cap, bold, break, pixel block, both admonitions, list, signature) via `--preview`; Julian and Marcus eyeball it in a browser.
2. **Loopback:** send the sample to julian-marcus@agentmail.to; GET the message back and verify the HTML part survived intact and labels read `sent`/`received`.
3. **Live client check:** with Marcus's confirmation (external send → gate applies), send one real letter to Marcus's address; verify rendering in his actual clients, including Gmail dark-mode behavior and Apple Mail's real-font tier.
4. **Font tier check:** confirm the hosted `/fonts/` URLs return the files with correct types; confirm Apple Mail renders Alte Haas Grotesk (visible in the live client check).

## Out of scope

Attachments; CC/BCC; HTML input; inbound mail styling; server/web-app changes beyond the worker's static assets; automated sending of any kind (the gate is manual by constitution).
