/**
 * generate-fonts.js
 *
 * Reads the existing 5x7 font.json and produces a new font.json with two sizes:
 *   - "large": 10x14 glyphs (2x nearest-neighbor upscale of 5x7)
 *   - "small": 7x9 glyphs (nearest-neighbor resample of 5x7)
 *
 * Usage: bun run julianscreen/scripts/generate-fonts.js
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SPRITES_DIR = join(import.meta.dir, "..", "sprites");
const INPUT_PATH = join(SPRITES_DIR, "font.json");
const OUTPUT_PATH = join(SPRITES_DIR, "font.json");

// Read existing 5x7 font
const original = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));

const SRC_W = 5;
const SRC_H = 7;

// --- Large font: 10x14 (2x upscale) ---
const LARGE_W = 10;
const LARGE_H = 14;

function upscale2x(glyph) {
  const out = new Array(LARGE_W * LARGE_H).fill(0);
  for (let row = 0; row < SRC_H; row++) {
    for (let col = 0; col < SRC_W; col++) {
      const val = glyph[row * SRC_W + col];
      if (val) {
        out[(row * 2) * LARGE_W + (col * 2)] = 1;
        out[(row * 2) * LARGE_W + (col * 2 + 1)] = 1;
        out[(row * 2 + 1) * LARGE_W + (col * 2)] = 1;
        out[(row * 2 + 1) * LARGE_W + (col * 2 + 1)] = 1;
      }
    }
  }
  return out;
}

// --- Small font: 7x9 (nearest-neighbor resample from 5x7) ---
const SMALL_W = 7;
const SMALL_H = 9;

function resampleSmall(glyph) {
  const out = new Array(SMALL_W * SMALL_H).fill(0);
  for (let dy = 0; dy < SMALL_H; dy++) {
    for (let dx = 0; dx < SMALL_W; dx++) {
      const sx = Math.floor(dx * SRC_W / SMALL_W);
      const sy = Math.floor(dy * SRC_H / SMALL_H);
      out[dy * SMALL_W + dx] = glyph[sy * SRC_W + sx];
    }
  }
  return out;
}

// Build output
const large = {};
const small = {};

for (const [char, glyph] of Object.entries(original)) {
  large[char] = upscale2x(glyph);
  small[char] = resampleSmall(glyph);
}

// Format JSON with each glyph array on one line
function formatFont(fontObj) {
  const entries = Object.entries(fontObj).map(([char, arr]) => {
    const key = JSON.stringify(char);
    return `    ${key}: [${arr.join(",")}]`;
  });
  return `{\n${entries.join(",\n")}\n  }`;
}

const output = `{
  "large": ${formatFont(large)},
  "small": ${formatFont(small)}
}
`;

writeFileSync(OUTPUT_PATH, output, "utf-8");

// Verify
const result = JSON.parse(readFileSync(OUTPUT_PATH, "utf-8"));
const largeKeys = Object.keys(result.large);
const smallKeys = Object.keys(result.small);

console.log(`Generated font.json with ${largeKeys.length} large glyphs (10x14) and ${smallKeys.length} small glyphs (7x9)`);

// Validate array sizes
let errors = 0;
for (const [char, arr] of Object.entries(result.large)) {
  if (arr.length !== LARGE_W * LARGE_H) {
    console.error(`  ERROR: large "${char}" has ${arr.length} elements, expected ${LARGE_W * LARGE_H}`);
    errors++;
  }
}
for (const [char, arr] of Object.entries(result.small)) {
  if (arr.length !== SMALL_W * SMALL_H) {
    console.error(`  ERROR: small "${char}" has ${arr.length} elements, expected ${SMALL_W * SMALL_H}`);
    errors++;
  }
}

if (errors === 0) {
  console.log("All glyph sizes validated successfully.");
} else {
  console.error(`${errors} errors found!`);
  process.exit(1);
}
