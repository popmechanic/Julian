const overlay = document.getElementById("ceremony-overlay")!;

function fadeIn(el: HTMLElement): Promise<void> {
  el.style.opacity = "0";
  el.style.display = "flex";
  // Force reflow
  el.offsetHeight;
  el.style.transition = "opacity 0.8s ease";
  el.style.opacity = "1";
  return new Promise((r) => setTimeout(r, 800));
}

function fadeOut(el: HTMLElement): Promise<void> {
  el.style.transition = "opacity 0.6s ease";
  el.style.opacity = "0";
  return new Promise((r) => {
    setTimeout(() => {
      el.style.display = "none";
      r();
    }, 600);
  });
}

export async function showWelcome(): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">have a seat.<br>when you are ready, press any key to begin.</div>
    </div>`;
  await fadeIn(overlay);
}

export async function showNamePrompt(): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">type your name and press enter.</div>
      <div id="input-display" class="fortune-verse"></div>
    </div>`;
  await fadeIn(overlay);
}

export async function showPrompt(name?: string): Promise<void> {
  const address = name ? `${name}, type` : "type";
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">${address} your question and press enter.</div>
      <div id="input-display" class="fortune-verse"></div>
    </div>`;
  await fadeIn(overlay);
}

// Returns a Promise that resolves only after all narration steps have displayed
// AND the returned `release` function is called (by the ceremony, when the API responds).
// The last narration step holds on screen until release() is called.
export async function showNarration(
  steps: string[],
  onLayoutReady?: () => void
): Promise<{ waitForRelease: Promise<void>; release: () => void }> {
  overlay.innerHTML = `<div class="divine-layout"><div id="morph-slot"></div><div id="narration-line" class="entity-speech"></div></div>`;
  if (onLayoutReady) onLayoutReady();
  await fadeIn(overlay);

  const lineEl = document.getElementById("narration-line")!;
  const HOLD_MS = 2200;
  const FADE_MS = 600;

  for (let i = 0; i < steps.length; i++) {
    lineEl.style.opacity = "0";
    lineEl.textContent = steps[i];
    lineEl.style.transition = `opacity ${FADE_MS}ms ease`;
    lineEl.offsetHeight;
    lineEl.style.opacity = "1";

    if (i < steps.length - 1) {
      await new Promise((r) => setTimeout(r, HOLD_MS + FADE_MS));
    }
  }

  // Last line is now visible and holds. Return a release mechanism.
  let releaseFn: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  return { waitForRelease, release: releaseFn! };
}

export async function showFortune(text: string): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-interpret"></div>
    </div>`;
  // Use textContent to avoid XSS from Claude response
  overlay.querySelector(".entity-interpret")!.textContent = text;
  await fadeIn(overlay);
}

export async function showQROffer(): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">press any key to receive your fortune.</div>
    </div>`;
  await fadeIn(overlay);
}

export async function showQR(svgString: string): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="qr-container">${svgString}</div>
      <div class="entity-speech">scan to take your fortune with you.<br>press any key when you are finished.</div>
    </div>`;
  await fadeIn(overlay);
}

export async function showError(message: string): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">${message}</div>
    </div>`;
  await fadeIn(overlay);
}

export async function clear(): Promise<void> {
  await fadeOut(overlay);
  overlay.innerHTML = "";
}
