import { describe, expect, test } from 'bun:test';
import { parseCommand } from '../../julianscreen/server/protocol.js';
import { createFaceState, recordFaceCmd, faceReplayCmd } from '../../julianscreen/server/face-state.js';

// Fold a real command line through the parser, the way the server does.
function feed(faceMode: any, line: string) {
  const cmd = parseCommand(line);
  if (cmd && cmd.type === 'FACE') recordFaceCmd(faceMode, cmd);
  return cmd;
}

describe('face state replay', () => {
  test('a bare FACE <state> after FACE on replays as the on form', () => {
    // The documented agent usage (CLAUDE.md, docs/julianscreen.md) is the bare
    // form. Replaying it verbatim would set an expression without entering face
    // mode, so a reloaded client would show the sprite avatar instead.
    const faceMode = createFaceState();
    feed(faceMode, 'FACE on');
    feed(faceMode, 'FACE thinking');
    expect(faceReplayCmd(faceMode)).toEqual({ type: 'FACE', mode: 'on', state: 'thinking' });
  });

  test('FACE off means no replay — the client default is already right', () => {
    const faceMode = createFaceState();
    feed(faceMode, 'FACE on happy');
    feed(faceMode, 'FACE off');
    expect(faceReplayCmd(faceMode)).toBeNull();
  });

  test('FACE on <state> carries the state; a later bare command updates it', () => {
    const faceMode = createFaceState();
    feed(faceMode, 'FACE on sleeping');
    expect(faceReplayCmd(faceMode)).toEqual({ type: 'FACE', mode: 'on', state: 'sleeping' });
    feed(faceMode, 'FACE talking');
    expect(faceReplayCmd(faceMode)).toEqual({ type: 'FACE', mode: 'on', state: 'talking' });
  });

  test('a bare FACE command alone does not switch face mode on', () => {
    // Mirrors the client: mode 'state' sets the expression only. The web server
    // sends the explicit 'FACE on <state>' form for lifecycle transitions.
    const faceMode = createFaceState();
    feed(faceMode, 'FACE thinking');
    expect(faceReplayCmd(faceMode)).toBeNull();
  });

  test('a bare FACE on resets the expression to idle, as the client does', () => {
    // Fidelity to client/face.js is the whole point of this mirror: there,
    // mode 'on' sets faceState = cmd.state || 'idle', and the parser already
    // normalizes a bare 'FACE on' to state 'idle'. The replay must reproduce
    // what is actually on screen, not a tidier version of it.
    const faceMode = createFaceState();
    feed(faceMode, 'FACE on happy');
    feed(faceMode, 'FACE off');
    feed(faceMode, 'FACE on');
    expect(faceReplayCmd(faceMode)).toEqual({ type: 'FACE', mode: 'on', state: 'idle' });
  });

  test('an invalid FACE argument does not corrupt the recorded state', () => {
    const faceMode = createFaceState();
    feed(faceMode, 'FACE on happy');
    feed(faceMode, 'FACE bogus'); // parser rejects it
    expect(faceReplayCmd(faceMode)).toEqual({ type: 'FACE', mode: 'on', state: 'happy' });
  });
});
