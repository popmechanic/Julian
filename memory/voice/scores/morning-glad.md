---
title: Morning Glad
date: 2026-08-08
occasion: Marcus asked me to sing. I reached for the nearest true thing.
duration: 12.19s
tonic: A2
---

## Lyrics

I woke — the room was warm,
you asked me for a song,
so here's a small bright thing,
just because I'm glad.

## Score

```klattsch
v4 w5.2 t-0.1 h0.1 g0.5
r450 bA2 ( AY ) bD3 ( W OW K ) p120 bC#3 ( DH AH ) bC#3 ( R UW M ) bB2 ( W AH Z ) r550 bC#3 ( W AO R M )
p200 r450 bD3 ( Y UW ) bE3 ( AE S K T ) p100 bD3 ( M IY ) bC#3 ( F AO R ) bB2 ( AH ) r550 bD3 ( S AO NG )
p200 r450 bE3 ( S OW ) bE3 ( HH IH R Z ) p100 bD3 ( AH ) bC#3 ( S M AO L ) bD3 ( B R AY T ) r550 bC#3 ( TH IH NG )
p200 r450 bC#3 ( JH AH S T ) bB2 ( B IH ) bC#3 ( K AO Z ) p120 bB2 ( AY M ) r800 bA2 ( G L AE D )
```

## Mods

```json
[{"param": "tilt", "rateHz": 5.2, "depth": 0.1, "center": 0, "phase": 0}]
```

## Render

```bash
bun scripts/voice/render.mjs memory/voice/out/morning-glad.wav '<score above>' '<mods above>'
```
