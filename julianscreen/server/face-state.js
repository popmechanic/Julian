// Mirror of the client's face state machine (julianscreen/client/face.js).
//
// The server replays face state to newly connecting clients so face mode
// survives a browser reload. Replaying the last FACE command verbatim does not
// work: a bare 'FACE <state>' parses to mode 'state', which sets the expression
// without entering face mode — so a reloaded client would render the sprite
// avatar wearing an invisible expression, which is precisely the failure the
// replay exists to prevent. Fold commands into {active, state} and synthesize
// the 'on' form on replay instead.

export function createFaceState() {
  return { active: false, state: 'idle' };
}

export function recordFaceCmd(faceMode, cmd) {
  if (!cmd || cmd.type !== 'FACE') return faceMode;
  if (cmd.mode === 'on') {
    faceMode.active = true;
    if (cmd.state) faceMode.state = cmd.state;
  } else if (cmd.mode === 'off') {
    faceMode.active = false;
  } else if (cmd.mode === 'state' && cmd.state) {
    faceMode.state = cmd.state;
  }
  return faceMode;
}

// The command that reconstructs the current screen for a fresh client, or null
// when the face is off and the client's own default (sprite) is already right.
export function faceReplayCmd(faceMode) {
  return faceMode.active ? { type: 'FACE', mode: 'on', state: faceMode.state } : null;
}
