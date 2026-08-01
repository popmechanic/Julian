#!/usr/bin/env bun
// jscreen-render — offline renderer: a .jscreen command list -> PNG, using the
// SAME primitives as julianscreen/client/renderer.js so file and screen agree by
// construction. Draw-layer only (RECT/CIRC/LINE/DOT/COL/CLR) over the #0F0F0F base.
// Usage: bun scripts/jscreen-render.ts <in.jscreen> <out.png> [scale]
import { readFileSync, writeFileSync } from 'fs';
import { deflateSync } from 'node:zlib';

const W = 640, H = 480;
const PALETTE = [
  null, '#FFD600', '#0F0F0F', '#FFFFFF', '#FF4444', '#44FF44', '#4488FF',
  '#FF88FF', '#FFAA00', '#00CCCC', '#8844FF', '#888888', '#444444',
  '#CCCCCC', '#664400', '#226622',
];
const BG = [0x0f, 0x0f, 0x0f];
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const buf = new Uint8Array(W * H * 3);
const reset = () => { for (let i = 0; i < W * H; i++) { buf[i*3]=BG[0]; buf[i*3+1]=BG[1]; buf[i*3+2]=BG[2]; } };
reset();

let col = 1;
const px = (x: number, y: number) => {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const c = PALETTE[col]; if (!c) return; // transparent -> leave bg
  const [r, g, b] = hex(c); const i = (y * W + x) * 3; buf[i]=r; buf[i+1]=g; buf[i+2]=b;
};
const rect = (x: number, y: number, w: number, h: number) => { for (let yy=y; yy<y+h; yy++) for (let xx=x; xx<x+w; xx++) px(xx, yy); };
const circ = (cx: number, cy: number, r: number) => {           // Bresenham midpoint, matches client
  let x = r, y = 0, d = 1 - r;
  while (x >= y) {
    px(cx+x, cy+y); px(cx-x, cy+y); px(cx+x, cy-y); px(cx-x, cy-y);
    px(cx+y, cy+x); px(cx-y, cy+x); px(cx+y, cy-x); px(cx-y, cy-x);
    y++; if (d <= 0) d += 2*y+1; else { x--; d += 2*(y-x)+1; }
  }
};
const line = (x0: number, y0: number, x1: number, y1: number) => {  // Bresenham, matches client
  const dx = Math.abs(x1-x0), sx = x0<x1?1:-1;
  const dy = -Math.abs(y1-y0), sy = y0<y1?1:-1;
  let err = dx+dy;
  while (true) { px(x0, y0); if (x0===x1 && y0===y1) break; const e2 = 2*err; if (e2>=dy){err+=dy;x0+=sx;} if (e2<=dx){err+=dx;y0+=sy;} }
};

const src = readFileSync(process.argv[2], 'utf-8');
for (const raw of src.split('\n')) {
  const t = raw.trim(); if (!t) continue;
  const p = t.split(/\s+/); const n = p.map(Number);
  switch (p[0]) {
    case 'COL': col = n[1]; break;
    case 'CLR': reset(); break;
    case 'RECT': rect(n[1], n[2], n[3], n[4]); break;
    case 'CIRC': circ(n[1], n[2], n[3]); break;
    case 'LINE': line(n[1], n[2], n[3], n[4]); break;
    case 'DOT': px(n[1], n[2]); break;
    // FACE, BG, and everything else are not draw-layer ops — ignored.
  }
}

// --- minimal PNG encoder (color type 2, 8-bit RGB), IDAT via zlib (Bun.deflateSync) ---
const scale = Math.max(1, parseInt(process.argv[4] || '1', 10));
const OW = W * scale, OH = H * scale;
const raw = new Uint8Array(OH * (1 + OW * 3));
for (let y = 0; y < OH; y++) {
  const rowStart = y * (1 + OW * 3); raw[rowStart] = 0; // filter: none
  const sy = (y / scale) | 0;
  for (let x = 0; x < OW; x++) {
    const sx = (x / scale) | 0; const si = (sy * W + sx) * 3; const di = rowStart + 1 + x * 3;
    raw[di]=buf[si]; raw[di+1]=buf[si+1]; raw[di+2]=buf[si+2];
  }
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i=0;i<b.length;i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c>>>8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (v: number) => new Uint8Array([(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255]);
const chunk = (type: string, data: Uint8Array) => {
  const tb = new Uint8Array([...type].map(c => c.charCodeAt(0)));
  const body = new Uint8Array(tb.length + data.length); body.set(tb); body.set(data, tb.length);
  return new Uint8Array([...u32(data.length), ...body, ...u32(crc32(body))]);
};
const ihdr = new Uint8Array([...u32(OW), ...u32(OH), 8, 2, 0, 0, 0]);
const idat = deflateSync(raw);
const png = new Uint8Array([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0)),
]);
writeFileSync(process.argv[3], png);
console.log(`wrote ${process.argv[3]} (${OW}x${OH}, ${png.length} bytes)`);
