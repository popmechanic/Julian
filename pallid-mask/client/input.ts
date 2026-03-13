import type { InputResult } from "./types";

export function captureName(): Promise<string> {
  return new Promise((resolve) => {
    let name = "";
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
        name = name.slice(0, -1);
      } else if (e.key.length === 1) {
        name += e.key;
      }

      if (displayEl) {
        displayEl.textContent = name;
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
        question = question.slice(0, -1);
      } else if (e.key.length === 1) {
        const now = performance.now();
        timings.push(Math.round(now - lastTime));
        lastTime = now;
        question += e.key;
      }

      if (displayEl) {
        displayEl.textContent = question;
      }
    }

    document.addEventListener("keydown", onKey);
  });
}
