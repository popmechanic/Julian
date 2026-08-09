import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startSession, endSession } from './api';
import { store } from './store';

vi.mock('./auth', () => ({ getToken: async () => 'tok' }));

describe('session api', () => {
  beforeEach(() => {
    store.delTable('messages');
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as never;
  });
  afterEach(() => vi.restoreAllMocks());

  test('startSession posts the tail as previousTranscript', async () => {
    store.setRow('messages', 'm1', { kind: 'chat', role: 'user', speakerName: 'Marcus', text: 'hello', ts: 1, sessionId: 's' } as never);
    await startSession();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/session/start');
    const body = JSON.parse(init.body);
    expect(body.previousTranscript).toEqual([
      { role: 'user', speakerType: 'human', speakerName: 'Marcus', text: 'hello', ts: 1 },
    ]);
  });

  test('plain endSession sends no body; final end sends {final: true}', async () => {
    await endSession();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBeUndefined();
    await endSession(true);
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body)).toEqual({ final: true });
  });

});

// There is no component-rendering harness in `app/` (vitest runs in node, no
// @testing-library/svelte), so these guard the session controls at the source
// level: they read the two component files and assert on the exact markup that
// decides what Marcus sees and clicks. They fail if any label, title, casing,
// size hierarchy, confirm string, or handler wiring is reverted.
const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

function button(source: string, className: string): { title: string; label: string } {
  const match = source.match(new RegExp(`<button class="${className}"([^>]*)>([\\s\\S]*?)</button>`));
  if (!match) throw new Error(`no <button class="${className}"> found`);
  const title = match[1].match(/title="([^"]*)"/);
  if (!title) throw new Error(`<button class="${className}"> has no title attribute`);
  return { title: title[1], label: match[2] };
}

function rule(source: string, selector: string): string {
  const match = source.match(new RegExp(`\\${selector} \\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`no CSS rule for ${selector}`);
  return match[1];
}

function declaration(body: string, property: string): string {
  const match = body.match(new RegExp(`${property}:\\s*([^;]+);`));
  if (!match) throw new Error(`no ${property} declaration in rule`);
  return match[1].trim();
}

describe('session control hierarchy and copy', () => {
  const faceHeader = readSource('../components/FaceHeader.svelte');
  const app = readSource('../App.svelte');

  test('the pause control is the primary, labeled REST, and promises resumption', () => {
    expect(button(faceHeader, 'end')).toEqual({
      title: 'Pause — Julian resumes this same session next start',
      label: 'REST',
    });
  });

  test('the destructive control is labeled END FOR GOOD and says it is permanent', () => {
    expect(button(faceHeader, 'end-final danger')).toEqual({
      title: 'Ends this session permanently — the next one starts fresh',
      label: 'END FOR GOOD',
    });
  });

  test('CSS does not re-case the destructive label away from END FOR GOOD', () => {
    expect(declaration(rule(faceHeader, '.end-final'), 'text-transform')).toBe('uppercase');
  });

  test('the destructive control is the smaller of the two', () => {
    const rem = (body: string) => Number(declaration(body, 'font-size').replace('rem', ''));
    expect(rem(rule(faceHeader, '.end-final'))).toBeLessThan(rem(rule(faceHeader, '.end')));
  });

  test('the confirm copy names exactly what is lost', () => {
    const confirmed = app.match(/confirm\('([^']*)'\)/);
    expect(confirmed?.[1]).toBe(
      'End this session for good? This cannot be resumed — the next session starts fresh, inheriting only the recent record.',
    );
  });

  test('REST pauses without a confirm; END FOR GOOD ends finally behind one', () => {
    expect(app).toContain('onEnd={() => endSession()}');
    const handler = app.match(/onEndFinal=\{([\s\S]*?)\n\s*\}\}/);
    if (!handler) throw new Error('no onEndFinal handler found in App.svelte');
    expect(handler[1]).toContain("confirm('End this session for good?");
    expect(handler[1]).toContain('await endSession(true)');
    expect(handler[1]).not.toMatch(/endSession\(\)/);
  });
});
