import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SPRITES_DIR = join(import.meta.dir, "..", "sprites");

/**
 * Upscale a 16x16 flat array (256 values) to a 32x32 flat array (1024 values)
 * by doubling each pixel into a 2x2 block.
 */
function upscale16to32(frame) {
  if (frame.length !== 256) {
    throw new Error(`Expected 256 values, got ${frame.length}`);
  }

  const result = new Array(1024);

  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const value = frame[y * 16 + x];
      const newX = x * 2;
      const newY = y * 2;

      // Fill 2x2 block in the 32-wide grid
      result[newY * 32 + newX] = value;         // (2x,   2y)
      result[newY * 32 + newX + 1] = value;     // (2x+1, 2y)
      result[(newY + 1) * 32 + newX] = value;   // (2x,   2y+1)
      result[(newY + 1) * 32 + newX + 1] = value; // (2x+1, 2y+1)
    }
  }

  return result;
}

/**
 * Format a flat sprite array as rows of 32 values per line (matching original
 * style of 16 values per line for 16x16 sprites).
 */
function formatSpriteArray(arr, indent) {
  const rows = [];
  for (let i = 0; i < arr.length; i += 32) {
    rows.push(indent + "  " + arr.slice(i, i + 32).join(","));
  }
  return "[\n" + rows.join(",\n") + "\n" + indent + "]";
}

/**
 * Serialize a flat object { key: array, ... } with formatted sprite rows.
 */
function serializeFlatSpriteFile(obj) {
  const entries = Object.entries(obj).map(([key, arr]) => {
    return `  ${JSON.stringify(key)}: ${formatSpriteArray(arr, "  ")}`;
  });
  return "{\n" + entries.join(",\n\n") + "\n}\n";
}

/**
 * Serialize avatar.json with its nested structure:
 * { frames: { ... }, animations: { ... }, events: { ... } }
 */
function serializeAvatarFile(avatar) {
  // frames
  const frameEntries = Object.entries(avatar.frames).map(([key, arr]) => {
    return `    ${JSON.stringify(key)}: ${formatSpriteArray(arr, "    ")}`;
  });
  const framesBlock = `  "frames": {\n${frameEntries.join(",\n")}\n  }`;

  // animations and events as standard JSON with 4-space indent
  const animBlock = `  "animations": ${JSON.stringify(avatar.animations, null, 4).replace(/\n/g, "\n  ")}`;
  const eventsBlock = `  "events": ${JSON.stringify(avatar.events, null, 4).replace(/\n/g, "\n  ")}`;

  return `{\n${framesBlock},\n\n${animBlock},\n\n${eventsBlock}\n}\n`;
}

// --- avatar.json ---
const avatarPath = join(SPRITES_DIR, "avatar.json");
const avatar = JSON.parse(readFileSync(avatarPath, "utf-8"));

const frameKeys = Object.keys(avatar.frames);
for (const key of frameKeys) {
  avatar.frames[key] = upscale16to32(avatar.frames[key]);
}
// animations and events stay unchanged

writeFileSync(avatarPath, serializeAvatarFile(avatar));
console.log(`avatar.json: upscaled ${frameKeys.length} frames (${frameKeys.join(", ")})`);

// --- tiles.json ---
const tilesPath = join(SPRITES_DIR, "tiles.json");
const tiles = JSON.parse(readFileSync(tilesPath, "utf-8"));

const tileKeys = Object.keys(tiles);
for (const key of tileKeys) {
  tiles[key] = upscale16to32(tiles[key]);
}

writeFileSync(tilesPath, serializeFlatSpriteFile(tiles));
console.log(`tiles.json: upscaled ${tileKeys.length} tiles (${tileKeys.join(", ")})`);

// --- items.json ---
const itemsPath = join(SPRITES_DIR, "items.json");
const items = JSON.parse(readFileSync(itemsPath, "utf-8"));

const itemKeys = Object.keys(items);
for (const key of itemKeys) {
  items[key] = upscale16to32(items[key]);
}

writeFileSync(itemsPath, serializeFlatSpriteFile(items));
console.log(`items.json: upscaled ${itemKeys.length} items (${itemKeys.join(", ")})`);

console.log("\nDone. All sprites upscaled from 16x16 (256 values) to 32x32 (1024 values).");
