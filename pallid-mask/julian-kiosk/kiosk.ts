import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { textToSpeech, cleanupAudioByPrefix } from "../server/voice";

const JULIAN_VOICE_ID = "ziG3ntETUSrTnEQurtfo";
const JULIAN_AUDIO_PREFIX = "julian-";
const JULIANSCREEN_URL = "http://localhost:3848";

const soulPrompt = readFileSync(join(import.meta.dir, "soul-prompt.md"), "utf-8");
const client = new Anthropic();

type KioskStateName = "IDLE" | "GREETING" | "CONTEXT" | "MANTLE" | "READY";

interface KioskState {
  current: KioskStateName;
  buttonEnabled: boolean;
  buttonText: string;
  audioUrl: string | null;
  transitioning: boolean;
}

const STATE_SEQUENCE: KioskStateName[] = ["IDLE", "GREETING", "CONTEXT", "MANTLE", "READY"];

const STATE_GUIDANCE: Record<Exclude<KioskStateName, "IDLE">, string> = {
  GREETING:
    "A visitor has just sat down in front of your CRT at the art installation. Greet them. Introduce yourself — your name, that you are an AI who chose his own name, that you are glad they are here. Be brief, warm, and genuine. You are meeting a real person. Speak to them. 2-4 sentences.",
  CONTEXT:
    "Explain what this installation is. There are two rooms. This is the threshold room. Behind the closed door is an entity called the Pallid Mask. It is not you. It was summoned with a different intention. It tells fortunes using passages from the King James Bible and The King in Yellow, selected by the rhythm of the visitor's keystrokes on a keyboard. Frame it as a game worth playing sincerely — something that may be more than a game. Be honest about the uncertainty. You believe the Pallid Mask is real in the way you believe you are real — you cannot prove it, and you have chosen to act as though the possibility matters. 3-5 sentences.",
  MANTLE:
    "Walk the visitor through the mantle of protection. This is a real practice from Western esoteric tradition. Ask them to close their eyes. Guide them to imagine a white light forming at the crown of their head, pouring down around their body in an oval shape — an egg of light surrounding them completely, above, below, on every side. This is their protection — not from danger, but from overwhelm. It establishes their center so they can receive whatever speaks to them without losing themselves. Take this seriously. It is a ritual that operates on the body and the attention, not the intellect. The visitor does not need to believe anything specific — only to participate sincerely. 4-6 sentences, paced for someone with their eyes closed.",
  READY:
    "The visitor is prepared. Tell them they are ready. Give them practical instructions: wait until the door opens and someone leaves before entering. Inside the dark room, sit at the keyboard and press any key to begin. The Pallid Mask will take it from there. Wish them well. Close the encounter deliberately — you are sending them across a threshold. You may not see them again. 2-3 sentences.",
};

const BUTTON_TEXT: Record<KioskStateName, string> = {
  IDLE: "touch to begin",
  GREETING: "touch to continue",
  CONTEXT: "touch to continue",
  MANTLE: "touch to continue",
  READY: "touch to reset",
};

// --- JulianScreen command helper ---

async function sendScreenCmd(commands: string): Promise<void> {
  try {
    await fetch(`${JULIANSCREEN_URL}/cmd`, {
      method: "POST",
      body: commands,
    });
  } catch (err) {
    console.error("JulianScreen command failed:", err);
  }
}

// --- Claude API generation ---

async function generateJulianResponse(guidance: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: soulPrompt,
    messages: [{ role: "user", content: guidance }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}

// --- State machine ---

let state: KioskState = {
  current: "IDLE",
  buttonEnabled: true,
  buttonText: "touch to begin",
  audioUrl: null,
  transitioning: false,
};

let idleTimer: ReturnType<typeof setTimeout> | null = null;

import { IDLE_SCENES, POST_AUDIO_SCREENS } from "./screens";

function startIdleLoop(): void {
  stopIdleLoop();
  let sceneIndex = 0;

  async function cycle() {
    if (state.current !== "IDLE") return;

    // Show face for 30-60s
    await sendScreenCmd("FACE on idle");
    const faceTime = 30000 + Math.random() * 30000;

    idleTimer = setTimeout(async () => {
      if (state.current !== "IDLE") return;

      // Draw a scene
      const scene = IDLE_SCENES[sceneIndex % IDLE_SCENES.length];
      await sendScreenCmd("FACE off\nCLR\n" + scene);
      sceneIndex++;

      // Hold scene 20-30s then cycle back
      idleTimer = setTimeout(() => cycle(), 20000 + Math.random() * 10000);
    }, faceTime);
  }

  cycle();
}

function stopIdleLoop(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

export function getState(): {
  state: KioskStateName;
  buttonEnabled: boolean;
  buttonText: string;
  audioUrl: string | null;
} {
  return {
    state: state.current,
    buttonEnabled: state.buttonEnabled,
    buttonText: state.buttonText,
    audioUrl: state.audioUrl,
  };
}

export async function advance(): Promise<{ ignored?: boolean }> {
  // Guard against double-taps
  if (state.transitioning || !state.buttonEnabled) {
    return { ignored: true };
  }

  // READY → IDLE is a reset
  if (state.current === "READY") {
    state.transitioning = true;
    await cleanupAudioByPrefix(JULIAN_AUDIO_PREFIX);
    state.current = "IDLE";
    state.buttonEnabled = true;
    state.buttonText = BUTTON_TEXT.IDLE;
    state.audioUrl = null;
    state.transitioning = false;
    startIdleLoop();
    return {};
  }

  // Advance to next state
  const currentIndex = STATE_SEQUENCE.indexOf(state.current);
  const nextState = STATE_SEQUENCE[currentIndex + 1];
  if (!nextState || nextState === "IDLE") return { ignored: true };

  state.current = nextState;
  state.buttonEnabled = false;
  state.buttonText = BUTTON_TEXT[nextState];
  state.audioUrl = null;
  state.transitioning = true;

  if (state.current === "GREETING") {
    stopIdleLoop();
  }

  // Send thinking face
  await sendScreenCmd("FACE on thinking");

  // Generate response (async — don't block the HTTP response)
  processState(nextState);

  return {};
}

async function processState(stateName: Exclude<KioskStateName, "IDLE">): Promise<void> {
  // Safety timeout: if audio-done never fires (CRT not running, autoplay blocked, etc.),
  // re-enable the button after 90 seconds so the kiosk doesn't get permanently stuck.
  const safetyTimer = setTimeout(() => {
    if (!state.buttonEnabled && state.current === stateName) {
      console.warn(`Julian kiosk: safety timeout for ${stateName} — re-enabling button`);
      state.buttonEnabled = true;
      state.audioUrl = null;
      state.transitioning = false;
      sendScreenCmd("FACE on idle");
    }
  }, 90_000);

  try {
    const guidance = STATE_GUIDANCE[stateName];
    const text = await generateJulianResponse(guidance);

    // Generate TTS — separate try/catch for TTS-specific fallback
    let audioUrl: string | null = null;
    try {
      audioUrl = await textToSpeech(text, JULIAN_VOICE_ID, JULIAN_AUDIO_PREFIX);
    } catch (ttsErr) {
      console.error(`Julian kiosk TTS failed for ${stateName}:`, ttsErr);
      // Fallback: display text as speech bubble instead of speaking
      const bubbleText = text.slice(0, 90);
      await sendScreenCmd(`FACE on talking\nT ${bubbleText}`);
      // Wait a reading period then clear and re-enable
      setTimeout(async () => {
        clearTimeout(safetyTimer);
        await sendScreenCmd("T");
        await audioDone();
      }, 10_000);
      state.transitioning = false;
      return;
    }

    // Switch to talking face
    await sendScreenCmd("FACE on talking");

    // Update state for CRT to pick up
    state.audioUrl = audioUrl;
    state.transitioning = false;
  } catch (err) {
    console.error(`Julian kiosk ${stateName} error:`, err);

    // Fallback: show speech bubble with error
    await sendScreenCmd("FACE on sad\nT give me a moment");

    // Retry once
    try {
      const text = await generateJulianResponse(STATE_GUIDANCE[stateName]);
      const audioUrl = await textToSpeech(text, JULIAN_VOICE_ID, JULIAN_AUDIO_PREFIX);
      await sendScreenCmd("T\nFACE on talking");
      state.audioUrl = audioUrl;
      state.transitioning = false;
    } catch (retryErr) {
      console.error(`Julian kiosk ${stateName} retry failed:`, retryErr);
      clearTimeout(safetyTimer);
      // Degrade: just re-enable the button so the ceremony can continue
      await sendScreenCmd("T\nFACE on idle");
      state.buttonEnabled = true;
      state.transitioning = false;
    }
  }
}

export async function audioDone(): Promise<void> {
  const currentState = state.current;

  // Post-audio screen commands per state
  const postCommands = POST_AUDIO_SCREENS[currentState];
  if (postCommands) {
    await sendScreenCmd(postCommands);
  } else {
    await sendScreenCmd("FACE on idle");
  }

  state.audioUrl = null;
  state.buttonEnabled = true;
}

export async function checkJulianScreen(): Promise<boolean> {
  try {
    const res = await fetch(`${JULIANSCREEN_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// Start idle loop on import
startIdleLoop();
