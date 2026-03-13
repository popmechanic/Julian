import type { InputResult } from "./types";

function renderWithCursor(el: HTMLElement, text: string, cursor: number): void {
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  el.textContent = "";
  const beforeNode = document.createTextNode(before);
  const cursorSpan = document.createElement("span");
  cursorSpan.className = "input-cursor";
  cursorSpan.textContent = "\u200B"; // zero-width space to give it height
  const afterNode = document.createTextNode(after);
  el.appendChild(beforeNode);
  el.appendChild(cursorSpan);
  el.appendChild(afterNode);
}

function captureText(opts: { recordTimings: boolean }): Promise<{ text: string; timings: number[] }> {
  return new Promise((resolve) => {
    const timings: number[] = [];
    let lastTime = performance.now();
    let text = "";
    let cursor = 0;
    const displayEl = document.getElementById("input-display");

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();

      if (e.key === "Enter" && text.length > 0) {
        document.removeEventListener("keydown", onKey);
        resolve({ text, timings });
        return;
      }

      if (e.key === "Backspace") {
        if (cursor > 0) {
          text = text.slice(0, cursor - 1) + text.slice(cursor);
          cursor--;
        }
      } else if (e.key === "Delete") {
        if (cursor < text.length) {
          text = text.slice(0, cursor) + text.slice(cursor + 1);
        }
      } else if (e.key === "ArrowLeft") {
        if (cursor > 0) cursor--;
      } else if (e.key === "ArrowRight") {
        if (cursor < text.length) cursor++;
      } else if (e.key === "Home") {
        cursor = 0;
      } else if (e.key === "End") {
        cursor = text.length;
      } else if (e.key.length === 1) {
        if (opts.recordTimings) {
          const now = performance.now();
          timings.push(Math.round(now - lastTime));
          lastTime = now;
        }
        text = text.slice(0, cursor) + e.key + text.slice(cursor);
        cursor++;
      }

      if (displayEl) {
        renderWithCursor(displayEl, text, cursor);
      }
    }

    document.addEventListener("keydown", onKey);
  });
}

export async function captureName(): Promise<string> {
  const { text } = await captureText({ recordTimings: false });
  return text;
}

export async function captureInput(): Promise<InputResult> {
  const { text, timings } = await captureText({ recordTimings: true });
  return { question: text, timings };
}
