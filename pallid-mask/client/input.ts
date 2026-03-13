import type { InputResult } from "./types";

export function captureInput(): Promise<InputResult> {
  return new Promise((resolve) => {
    const timings: number[] = [];
    let lastTime = performance.now();
    let question = "";
    const displayEl = document.getElementById("input-display");

    function onKey(e: KeyboardEvent) {
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
