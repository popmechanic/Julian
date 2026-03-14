# Fortune Projection UX Improvements — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve fortune app readability on a projected screen — slower narration, sharper text, natural voice pauses.

**Architecture:** Three independent changes: (1) increase narration hold time in `display.ts`, (2) reduce blur/glow in CSS and fortune template, (3) add SSML `<break>` tags before sending text to ElevenLabs TTS.

**Tech Stack:** TypeScript (Bun), CSS, ElevenLabs JS SDK

**Spec:** `docs/superpowers/specs/2026-03-13-fortune-projection-ux-design.md`

---

## Chunk 1: All Changes

These three tasks are independent and can be executed in parallel.

### Task 1: Increase narration hold time

**Files:**
- Modify: `pallid-mask/client/display.ts:65`

- [ ] **Step 1: Change HOLD_MS**

In `pallid-mask/client/display.ts`, line 65, change:

```typescript
const HOLD_MS = 2200;
```

to:

```typescript
const HOLD_MS = 3800;
```

- [ ] **Step 2: Verify build**

Run: `cd pallid-mask && bun build client/main.ts --outdir dist`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/client/display.ts
git commit -m "Narration timing: increase hold from 2.2s to 3.8s for projection readability"
```

---

### Task 2: Reduce blur and glow for projection readability

**Files:**
- Modify: `pallid-mask/templates/fortune.html:19`
- Modify: `pallid-mask/public/styles.css:290,299,309`

- [ ] **Step 1: Reduce fortune template blur**

In `pallid-mask/templates/fortune.html`, line 19, change:

```css
filter: blur(0.3px) hue-rotate(15deg);
```

to:

```css
filter: blur(0.15px) hue-rotate(15deg);
```

- [ ] **Step 2: Tighten .entity-speech glow**

In `pallid-mask/public/styles.css`, line 290, change:

```css
filter: drop-shadow(0 0 8px var(--c5)) drop-shadow(0 0 20px var(--c1));
```

to:

```css
filter: drop-shadow(0 0 5px var(--c5)) drop-shadow(0 0 12px var(--c1));
```

- [ ] **Step 3: Tighten .fortune-verse glow**

In `pallid-mask/public/styles.css`, line 299, change:

```css
filter: drop-shadow(0 0 6px var(--c2));
```

to:

```css
filter: drop-shadow(0 0 4px var(--c2));
```

- [ ] **Step 4: Tighten .entity-interpret glow**

In `pallid-mask/public/styles.css`, line 309, change:

```css
filter: drop-shadow(0 0 8px var(--c4)) drop-shadow(0 0 16px var(--c1));
```

to:

```css
filter: drop-shadow(0 0 5px var(--c4)) drop-shadow(0 0 10px var(--c1));
```

- [ ] **Step 5: Commit**

```bash
git add pallid-mask/templates/fortune.html pallid-mask/public/styles.css
git commit -m "Reduce blur and glow radii for projection readability"
```

---

### Task 3: Add SSML voice pauses at paragraph breaks

**Files:**
- Modify: `pallid-mask/server/voice.ts:14-18`

- [ ] **Step 1: Add prepareForSpeech function**

In `pallid-mask/server/voice.ts`, add this function before `textToSpeech`:

```typescript
function prepareForSpeech(text: string): string {
  return text
    .replace(/\n\n+/g, ' <break time="1.2s" /> ')
    .replace(/\n/g, " ");
}
```

- [ ] **Step 2: Use prepareForSpeech in textToSpeech**

In `pallid-mask/server/voice.ts`, line 16, change:

```typescript
    text,
```

to:

```typescript
    text: prepareForSpeech(text),
```

- [ ] **Step 3: Verify build**

Run: `cd pallid-mask && bun build server/index.ts --outdir dist/server --target bun`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add pallid-mask/server/voice.ts
git commit -m "Voice: add SSML break pauses at paragraph boundaries for natural pacing"
```
