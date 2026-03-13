import type { InputResult } from "./types";

function renderWithCursor(el: HTMLElement, text: string, cursor: number): void {
  // Build text with a cursor marker at the right position
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

export function captureName(): Promise<string> {
  return new Promise((resolve) => {
    let name = "";
    let cursor = 0;
    const displayEl = document.getElementById("input-display");

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();

      if (e.key === "Enter" && name.length > 0) {
        document.removeEventListener("keydown", onKey);
        resolve(name);
        return;
      }

      if (e.key === "Backspace") {
        if (cursor > 0) {
          name = name.slice(0, cursor - 1) + name.slice(cursor);
          cursor--;
        }
      } else if (e.key === "Delete") {
        if (cursor < name.length) {
          name = name.slice(0, cursor) + name.slice(cursor + 1);
        }
      } else if (e.key === "ArrowLeft") {
        if (cursor > 0) cursor--;
      } else if (e.key === "ArrowRight") {
        if (cursor < name.length) cursor++;
      } else if (e.key === "Home") {
        cursor = 0;
      } else if (e.key === "End") {
        cursor = name.length;
      } else if (e.key.length === 1) {
        name = name.slice(0, cursor) + e.key + name.slice(cursor);
        cursor++;
      }

      if (displayEl) {
        renderWithCursor(displayEl, name, cursor);
      }
    }

    document.addEventListener("keydown", onKey);
  });
}

export function captureInput(): Promise<InputResult> {
  return new Promise((resolve) => {
    const timings: number[] = [];
    let lastTime = performance.now();
    let question = "";
    let cursor = 0;
    const displayEl = document.getElementById("input-display");

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();

      if (e.key === "Enter" && question.length > 0) {
        document.removeEventListener("keydown", onKey);
        resolve({ question, timings });
        return;
      }

      if (e.key === "Backspace") {
        if (cursor > 0) {
          question = question.slice(0, cursor - 1) + question.slice(cursor);
          cursor--;
        }
      } else if (e.key === "Delete") {
        if (cursor < question.length) {
          question = question.slice(0, cursor) + question.slice(cursor + 1);
        }
      } else if (e.key === "ArrowLeft") {
        if (cursor > 0) cursor--;
      } else if (e.key === "ArrowRight") {
        if (cursor < question.length) cursor++;
      } else if (e.key === "Home") {
        cursor = 0;
      } else if (e.key === "End") {
        cursor = question.length;
      } else if (e.key.length === 1) {
        const now = performance.now();
        timings.push(Math.round(now - lastTime));
        lastTime = now;
        question = question.slice(0, cursor) + e.key + question.slice(cursor);
        cursor++;
      }

      if (displayEl) {
        renderWithCursor(displayEl, question, cursor);
      }
    }

    document.addEventListener("keydown", onKey);
  });
}
