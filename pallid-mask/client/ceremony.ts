import type { CeremonyState, FortuneResponse } from "./types";
import * as mask from "./mask";
import * as sigils from "./sigils";
import * as display from "./display";
import { captureName, captureInput } from "./input";
import { requestGreeting, requestAcknowledge, requestFortune, requestReset } from "./api";

const NARRATION_STEPS = [
  "gathering the intervals between your keystrokes...",
  "deriving a seed from the rhythm of your intention...",
  "consulting the first text...",
  "consulting the second text...",
  "two passages have been drawn...",
  "the mask is interpreting...",
];

const QR_TIMEOUT_MS = 90_000;

let state: CeremonyState = "WELCOME";
let visitorName = "";

function playAudio(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Audio playback failed"));
    audio.play().catch(reject);
  });
}

function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      document.removeEventListener("keydown", onKey);
      resolve();
    }
    document.addEventListener("keydown", onKey);
  });
}

async function enterState(next: CeremonyState): Promise<void> {
  state = next;
  console.log(`[ceremony] → ${state}`);

  switch (state) {
    case "WELCOME": {
      await display.showWelcome();
      await waitForKey();
      // Enter true fullscreen on first interaction (hides PWA title bar)
      if (document.fullscreenEnabled && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      await display.clear();
      return enterState("SUMMON");
    }

    case "SUMMON": {
      mask.show();
      sigils.start();
      try {
        const greeting = await requestGreeting();
        await playAudio(greeting.audioUrl);
      } catch (err) {
        console.error("Greeting failed:", err);
        await handleError();
        return;
      }
      return enterState("NAME");
    }

    case "NAME": {
      await display.showNamePrompt();
      visitorName = await captureName();
      await display.clear();
      display.showSpinner();
      sigils.startSpinnerWarp();
      try {
        const ack = await requestAcknowledge(visitorName);
        sigils.stopSpinnerWarp();
        display.hideSpinner();
        await playAudio(ack.audioUrl);
      } catch (err) {
        sigils.stopSpinnerWarp();
        display.hideSpinner();
        console.error("Acknowledge failed:", err);
        await handleError();
        return;
      }
      return enterState("INPUT");
    }

    case "INPUT": {
      await display.showPrompt(visitorName);
      const input = await captureInput();
      await display.clear();
      display.showSpinner();
      sigils.startSpinnerWarp();
      return enterDivine(input.question, input.timings);
    }

    default:
      break;
  }
}

async function enterDivine(question: string, timings: number[]): Promise<void> {
  state = "DIVINE";
  console.log(`[ceremony] → DIVINE`);

  sigils.stopSpinnerWarp();
  display.hideSpinner();
  mask.hide();
  sigils.loadingMode();
  sigils.showMorph();

  // Start API call FIRST, then narration — both run in parallel
  let fortuneResult: FortuneResponse | null = null;
  let fortuneError: Error | null = null;

  // Kick off the fortune request immediately (runs concurrently with narration)
  const fortunePromise = requestFortune(visitorName, question, timings)
    .then((result) => { fortuneResult = result; })
    .catch((err) => { fortuneError = err as Error; });

  // Move morph SVG into centered overlay slot when layout is ready (before fade-in)
  const morphSvg = document.getElementById("sigil-morph-svg");
  const morphOriginalParent = morphSvg?.parentElement;

  const narration = await display.showNarration(NARRATION_STEPS, () => {
    const slot = document.getElementById("morph-slot");
    if (morphSvg && slot) slot.appendChild(morphSvg);
  });

  // Narration is done. Wait for API if it hasn't resolved yet.
  await fortunePromise;
  // Release the narration hold
  narration.release();

  // Move morph SVG back to its original container
  if (morphSvg && morphOriginalParent) {
    morphOriginalParent.appendChild(morphSvg);
  }

  sigils.hideMorph();
  sigils.normalMode();
  await display.clear();

  if (fortuneError || !fortuneResult) {
    await handleError();
    return;
  }

  // FORTUNE state — mask returns enlarged, reads fortune aloud
  state = "FORTUNE";
  console.log(`[ceremony] → FORTUNE`);
  mask.enlarge();
  mask.show();

  try {
    await playAudio(fortuneResult.audioUrl);
  } catch {
    // If audio fails, proceed anyway
  }

  mask.hide();
  mask.resetSize();

  // QR_DISPLAY — skip QR_OFFER, transition directly
  state = "QR_DISPLAY";
  console.log(`[ceremony] → QR_DISPLAY`);
  await display.showQR(fortuneResult.qrSvg);

  // Wait for keypress OR 90s timeout
  await Promise.race([
    waitForKey(),
    new Promise<void>((r) => setTimeout(r, QR_TIMEOUT_MS)),
  ]);

  await display.clear();
  await reset();
}

async function handleError(): Promise<void> {
  mask.hide();
  sigils.stop();
  await display.clear();
  await display.showError(
    "the mask has lost its voice.<br>press any key to begin again."
  );
  await waitForKey();
  await reset();
}

async function reset(): Promise<void> {
  mask.hide();
  sigils.stop();
  visitorName = "";
  await display.clear();
  await requestReset();
  return enterState("WELCOME");
}

export async function start(): Promise<void> {
  await sigils.init();
  await enterState("WELCOME");
}
