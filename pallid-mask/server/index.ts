import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { computeSeed, selectPassages, loadBible, loadYellow } from "./stichomancy";
import { generateFortune, generateGreeting, generateAcknowledge } from "./fortune";
import { textToSpeech, cleanupAudio } from "./voice";
import { generateQRSvg } from "./qr";
import { generateFortunePage } from "./fortune-page";
import type { FortuneRequest, GreetingResponse, FortuneResponse } from "./types";
import { getState, advance, audioDone, checkJulianScreen } from "../julian-kiosk/kiosk";

// Resolve paths relative to this file
const ROOT = join(import.meta.dir, "..");
const PUBLIC_DIR = join(ROOT, "public");
const FORTUNES_DIR = join(ROOT, "fortunes");
const DATA_DIR = join(ROOT, "data");
const AUDIO_DIR = join(PUBLIC_DIR, "audio");
const JULIAN_DIR = join(ROOT, "julian-kiosk");
const JULIAN_CLIENT_DIR = join(JULIAN_DIR, "client");

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

// Check JulianScreen availability
checkJulianScreen().then((ok) => {
  if (ok) {
    console.log("JulianScreen connected on port 3848");
  } else {
    console.warn("WARNING: JulianScreen not reachable on port 3848 — Julian kiosk will run in audio-only mode");
  }
});

function makeSigilSvg(index: number): string {
  const sigil = sigils[index % sigils.length];
  return `<svg viewBox="${sigil.vb}" xmlns="http://www.w3.org/2000/svg"><path d="${sigil.d}"/></svg>`;
}

const server = Bun.serve({
  port: PORT,
  websocket: {
    open(ws) {
      // Connect to upstream JulianScreen WebSocket
      const upstream = new WebSocket("ws://localhost:3848/ws");
      (ws as any)._upstream = upstream;
      upstream.onmessage = (e) => { try { ws.send(e.data as string); } catch {} };
      upstream.onclose = () => { try { ws.close(); } catch {} };
      upstream.onerror = () => { try { ws.close(); } catch {} };
    },
    message(ws, msg) {
      const upstream = (ws as any)._upstream as WebSocket | undefined;
      if (upstream && upstream.readyState === 1) upstream.send(msg as string);
    },
    close(ws) {
      const upstream = (ws as any)._upstream as WebSocket | undefined;
      if (upstream) { try { upstream.close(); } catch {} }
    },
  },
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

    if (req.method === "POST" && url.pathname === "/api/acknowledge") {
      try {
        const body = await req.json() as { name: string };
        const text = await generateAcknowledge(soulPrompt, body.name);
        const audioUrl = await textToSpeech(text);
        return Response.json({ text, audioUrl } satisfies GreetingResponse);
      } catch (err) {
        console.error("Acknowledge error:", err);
        return Response.json({ error: "Acknowledge generation failed" }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/fortune") {
      try {
        const body = (await req.json()) as FortuneRequest;
        const seed = computeSeed(body.timings);
        const passages = selectPassages(seed, yellow, bible);

        const { fortune, summaryWord } = await generateFortune(soulPrompt, passages, body.name, body.question);

        const sigilIndex = seed % sigils.length;
        const sigilSvg = makeSigilSvg(sigilIndex);

        const [audioUrl, fortunePage] = await Promise.all([
          textToSpeech(fortune),
          generateFortunePage({ fortune, sigilSvg, publicBaseUrl: PUBLIC_URL, name: body.name, summaryWord }),
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

    // --- Julian Kiosk API Routes ---

    if (req.method === "POST" && url.pathname === "/julian/api/advance") {
      const result = await advance();
      return Response.json(result);
    }

    if (req.method === "GET" && url.pathname === "/julian/api/state") {
      return Response.json(getState());
    }

    if (req.method === "POST" && url.pathname === "/julian/api/audio-done") {
      await audioDone();
      return Response.json({ ok: true });
    }

    // --- Julian Kiosk Static Files ---

    if (url.pathname === "/julian") {
      const file = Bun.file(join(JULIAN_CLIENT_DIR, "display.html"));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/julian/control") {
      const file = Bun.file(join(JULIAN_CLIENT_DIR, "control.html"));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html" } });
    }

    // --- JulianScreen Proxy (port 3848 not exposed externally) ---
    // Catches /julian/screen/* AND /julian/sprites/* (relative paths from JulianScreen scripts)

    if (url.pathname.startsWith("/julian/screen") || url.pathname.startsWith("/julian/sprites/")) {
      const screenPath = url.pathname.startsWith("/julian/screen")
        ? (url.pathname.slice("/julian/screen".length) || "/")
        : url.pathname.slice("/julian".length);  // /julian/sprites/x → /sprites/x

      // WebSocket upgrade
      if (screenPath === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req, { data: {} })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Proxy HTTP requests to JulianScreen
      const screenUrl = `http://localhost:3848${screenPath}${url.search}`;
      try {
        const proxyRes = await fetch(screenUrl, {
          method: req.method,
          headers: { "Content-Type": req.headers.get("Content-Type") || "text/plain" },
          body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined,
        });
        return new Response(proxyRes.body, {
          status: proxyRes.status,
          headers: proxyRes.headers,
        });
      } catch (err) {
        console.error("JulianScreen proxy error:", err);
        return new Response("JulianScreen unavailable", { status: 502 });
      }
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
console.log(`  Pallid Mask ceremony: http://localhost:${server.port}/`);
console.log(`  Julian kiosk (CRT):   http://localhost:${server.port}/julian`);
console.log(`  Julian control (iPad): http://localhost:${server.port}/julian/control`);
