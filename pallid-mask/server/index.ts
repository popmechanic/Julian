import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { computeSeed, selectPassages, loadBible, loadYellow } from "./stichomancy";
import { generateFortune, generateGreeting } from "./fortune";
import { textToSpeech, cleanupAudio } from "./voice";
import { generateQRSvg } from "./qr";
import { generateFortunePage } from "./fortune-page";
import type { FortuneRequest, GreetingResponse, FortuneResponse } from "./types";

// Resolve paths relative to this file
const ROOT = join(import.meta.dir, "..");
const PUBLIC_DIR = join(ROOT, "public");
const FORTUNES_DIR = join(ROOT, "fortunes");
const DATA_DIR = join(ROOT, "data");
const AUDIO_DIR = join(PUBLIC_DIR, "audio");

// Ensure runtime directories exist
for (const dir of [FORTUNES_DIR, AUDIO_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Load data into memory
const soulPrompt = readFileSync(join(ROOT, "soul.md"), "utf-8");
const bible = loadBible(readFileSync(join(DATA_DIR, "king-james-bible.txt"), "utf-8"));
const yellow = loadYellow(readFileSync(join(DATA_DIR, "king-in-yellow.txt"), "utf-8"));
const sigils: { vb: string; d: string }[] = JSON.parse(
  readFileSync(join(DATA_DIR, "sigils.json"), "utf-8")
);

console.log(`Loaded ${bible.length} Bible verses, ${yellow.length} King in Yellow passages, ${sigils.length} sigils`);

const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";
const PORT = parseInt(process.env.PORT || "3000", 10);

// Pre-fetched greeting cache
let cachedGreeting: { text: string; audioUrl: string } | null = null;
let greetingInFlight = false;

async function prefetchGreeting(): Promise<void> {
  if (greetingInFlight) return;
  greetingInFlight = true;
  try {
    const text = await generateGreeting(soulPrompt);
    const audioUrl = await textToSpeech(text);
    cachedGreeting = { text, audioUrl };
    console.log("Greeting pre-fetched");
  } catch (err) {
    console.error("Greeting pre-fetch failed:", err);
    cachedGreeting = null;
  } finally {
    greetingInFlight = false;
  }
}

// Start pre-fetching on boot
prefetchGreeting();

function makeSigilSvg(index: number): string {
  const sigil = sigils[index % sigils.length];
  return `<svg viewBox="${sigil.vb}" xmlns="http://www.w3.org/2000/svg"><path d="${sigil.d}"/></svg>`;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- API Routes ---

    if (req.method === "POST" && url.pathname === "/api/greeting") {
      try {
        if (cachedGreeting) {
          const greeting = cachedGreeting;
          cachedGreeting = null;
          prefetchGreeting();
          return Response.json(greeting satisfies GreetingResponse);
        }
        const text = await generateGreeting(soulPrompt);
        const audioUrl = await textToSpeech(text);
        prefetchGreeting();
        return Response.json({ text, audioUrl } satisfies GreetingResponse);
      } catch (err) {
        console.error("Greeting error:", err);
        return Response.json({ error: "Greeting generation failed" }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/fortune") {
      try {
        const body = (await req.json()) as FortuneRequest;
        const seed = computeSeed(body.timings);
        const passages = selectPassages(seed, yellow, bible);

        const fortune = await generateFortune(soulPrompt, passages, body.question);

        const sigilIndex = seed % sigils.length;
        const sigilSvg = makeSigilSvg(sigilIndex);

        const [audioUrl, fortunePage] = await Promise.all([
          textToSpeech(fortune),
          generateFortunePage({ fortune, sigilSvg, publicBaseUrl: PUBLIC_URL }),
        ]);

        const qrSvg = await generateQRSvg(fortunePage.publicUrl);

        return Response.json({
          fortune,
          qrSvg,
          publicUrl: fortunePage.publicUrl,
          audioUrl,
        } satisfies FortuneResponse);
      } catch (err) {
        console.error("Fortune error:", err);
        return Response.json({ error: "Fortune generation failed" }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      await cleanupAudio();
      prefetchGreeting();
      return Response.json({ ok: true });
    }

    // --- Static Files ---

    // Fortune pages
    if (url.pathname.startsWith("/fortunes/")) {
      const filePath = join(FORTUNES_DIR, url.pathname.slice("/fortunes/".length));
      if (!filePath.startsWith(FORTUNES_DIR)) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      }
      return new Response("Not found", { status: 404 });
    }

    // Data files (sigils.json for client)
    if (url.pathname.startsWith("/data/")) {
      const filePath = join(DATA_DIR, url.pathname.slice("/data/".length));
      if (!filePath.startsWith(DATA_DIR)) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
      return new Response("Not found", { status: 404 });
    }

    // Public static files (index.html, styles.css, dist/, audio/)
    let filePath = join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
    let file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // Assets (fonts, etc.)
    if (url.pathname.startsWith("/assets/")) {
      const assetsDir = join(ROOT, "assets");
      filePath = join(ROOT, url.pathname);
      if (!filePath.startsWith(assetsDir)) return new Response("Forbidden", { status: 403 });
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Pallid Mask server running on http://localhost:${server.port}`);
