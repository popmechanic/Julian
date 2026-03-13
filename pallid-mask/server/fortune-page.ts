import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

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
    parts.push(`html, body { font-family: 'Orpheus', Georgia, serif; }`);
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
}

export async function generateFortunePage(
  options: FortunePageOptions
): Promise<{ id: string; publicUrl: string; filePath: string }> {
  const id = randomUUID().slice(0, 12);
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
    .replace("{{FORTUNE}}", options.fortune);

  const filePath = join(FORTUNES_DIR, `${id}.html`);
  await Bun.write(filePath, html);

  const publicUrl = `${options.publicBaseUrl}/fortunes/${id}.html`;
  return { id, publicUrl, filePath };
}
