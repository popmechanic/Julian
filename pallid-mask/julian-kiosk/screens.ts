// Idle ambient scenes — pre-composed JulianScreen command strings
// Each scene is drawn on a black canvas (FACE off + CLR already sent by the idle loop)

export const IDLE_SCENES: string[] = [
  // Scene 1: The Observatory — geometric objects floating in void
  `COL 3
CIRC 50 40 20
COL 9
CIRC 80 200 30
LINE 50 200 110 200
LINE 55 185 105 185
LINE 55 215 105 215
COL 4
CIRC 550 250 60
CIRC 550 250 40
CIRC 550 250 20
LINE 490 250 610 250
LINE 492 240 608 240
LINE 492 260 608 260
COL 7
RECT 30 380 15 70
COL 9
RECT 50 360 15 90
COL 1
RECT 70 390 15 60
COL 3
DOT 350 440
DOT 351 440
DOT 350 441
DOT 351 441
DOT 350 442
DOT 351 442
DOT 349 443
DOT 352 443`,

  // Scene 2: Concentric circles — signal/transmission
  `COL 3
CIRC 320 240 120
CIRC 320 240 90
CIRC 320 240 60
CIRC 320 240 30
COL 9
DOT 320 240
DOT 321 240
DOT 320 241
DOT 321 241
COL 1
LINE 0 240 200 240
LINE 440 240 639 240
COL 6
DOT 100 120
DOT 540 360
DOT 200 400
DOT 450 80`,

  // Scene 3: The Threshold — a door shape
  `COL 3
RECT 240 60 160 380
COL 2
RECT 244 64 152 372
COL 3
LINE 240 440 400 440
COL 1
DOT 380 240
DOT 381 240
DOT 382 240
DOT 380 241
DOT 381 241
DOT 382 241
COL 6
DOT 160 200
DOT 480 300
DOT 100 400
DOT 550 100`,

  // Scene 4: Stars and witness — night sky
  `COL 3
DOT 50 30
DOT 120 80
DOT 200 20
DOT 310 60
DOT 400 40
DOT 480 90
DOT 560 25
DOT 600 70
DOT 80 120
DOT 350 110
DOT 520 130
DOT 170 150
COL 1
DOT 320 380
DOT 321 380
DOT 320 381
DOT 321 381
DOT 320 382
DOT 321 382
DOT 319 383
DOT 322 383
DOT 320 384
DOT 321 384
DOT 320 385
DOT 321 385
DOT 319 386
DOT 322 386
DOT 319 387
DOT 322 387`,
];

// Post-audio JulianScreen commands for each state
// These run after the CRT signals audio playback is complete
export const POST_AUDIO_SCREENS: Record<string, string | null> = {
  IDLE: null,
  GREETING: "FACE on idle",
  CONTEXT: "FACE on idle",
  // Mantle: draw the oval of light after speaking, then return to face
  MANTLE:
    `FACE off
CLR
COL 3
CIRC 320 240 160
CIRC 320 240 158
CIRC 320 240 140
COL 13
CIRC 320 240 100
COL 3
DOT 320 78
DOT 321 78
DOT 320 79
DOT 321 79
DOT 320 400
DOT 321 400
DOT 320 401
DOT 321 401
W 5000
FACE on idle`,
  // Ready: sparkle effect then happy face
  READY:
    `FACE off
F sparkle
W 1000
FACE on happy`,
};
