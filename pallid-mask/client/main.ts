import { start } from "./ceremony";

document.addEventListener("DOMContentLoaded", () => {
  start().catch((err) => {
    console.error("Ceremony failed to start:", err);
  });
});
