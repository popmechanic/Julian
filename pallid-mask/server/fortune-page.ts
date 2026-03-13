import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "visitor";
}

function resolveFilename(name: string, word: string): string {
  const safeName = sanitizeName(name);
  const safeWord = /^[a-z]+$/.test(word) && word.length > 0 && word.length <= 20
    ? word
    : randomUUID().slice(0, 6);
  const base = `${safeName}-${safeWord}`;

  let candidate = `${base}.html`;
  let counter = 2;
  while (existsSync(join(FORTUNES_DIR, candidate))) {
    candidate = `${base}-${counter}.html`;
    counter++;
  }
  return candidate;
}

const TEMPLATE_PATH = join(import.meta.dir, "..", "templates", "fortune.html");
const STYLES_PATH = join(import.meta.dir, "..", "public", "styles.css");
const FONT_PATH = join(import.meta.dir, "..", "assets", "Orpheus.otf");
const FORTUNES_DIR = join(import.meta.dir, "..", "fortunes");

let cachedFontFace: string | null = null;
let cachedStyles: string | null = null;

function getFontFace(): string {
  if (!cachedFontFace) {
    const fontBuffer = readFileSync(FONT_PATH);
    const fontBase64 = fontBuffer.toString("base64");
    cachedFontFace = `@font-face {
  font-family: 'Orpheus';
  src: url(data:font/opentype;base64,${fontBase64}) format('opentype');
  font-weight: normal;
  font-style: normal;
}`;
  }
  return cachedFontFace;
}

function getStyles(): string {
  if (!cachedStyles) {
    const css = readFileSync(STYLES_PATH, "utf-8");
    // Extract only the :root vars and .entity-interpret class
    const rootMatch = css.match(/:root\s*\{[^}]+\}/);
    const interpretMatch = css.match(/\.entity-interpret\s*\{[^}]+\}/);
    const parts: string[] = [];
    if (rootMatch) parts.push(rootMatch[0]);
    if (interpretMatch) parts.push(interpretMatch[0]);
    // Add base body/font styles
    parts.push(`*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }`);
    parts.push(`html, body { font-family: 'Orpheus', Georgia, serif; text-transform: lowercase; }`);
    cachedStyles = parts.join("\n");
  }
  return cachedStyles;
}

export function clearStyleCache(): void {
  cachedFontFace = null;
  cachedStyles = null;
}

export interface FortunePageOptions {
  fortune: string;
  sigilSvg: string;
  publicBaseUrl: string;
  name: string;
  summaryWord: string;
}

export async function generateFortunePage(
  options: FortunePageOptions
): Promise<{ id: string; publicUrl: string; filePath: string }> {
  const filename = resolveFilename(options.name, options.summaryWord);
  const id = filename.replace(/\.html$/, "");
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const date = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).toLowerCase();

  const html = template
    .replace("{{FONT_FACE}}", getFontFace())
    .replace("{{STYLES}}", getStyles())
    .replace("{{SIGIL}}", options.sigilSvg)
    .replace("{{DATE}}", date)
    .replace("{{FORTUNE}}", escapeHtml(options.fortune).replace(/\n\n+/g, "<br><br>").replace(/\n/g, "<br>"));

  const filePath = join(FORTUNES_DIR, filename);
  await Bun.write(filePath, html);

  const publicUrl = `${options.publicBaseUrl}/fortunes/${filename}`;
  return { id, publicUrl, filePath };
}
