import { afterEach, describe, expect, test } from 'bun:test';
import { buildRoomDoc, registerUITarget, uiActionTargets } from '../../server/room';

// The registry is a module-level singleton shared across every test file in
// the run; restore it so synthetic targets never leak into other suites.
const builtinCount = uiActionTargets.length;

describe('room discovery document', () => {
  afterEach(() => {
    uiActionTargets.length = builtinCount;
  });
  test('has frontmatter and the three ELF sections', () => {
    const doc = buildRoomDoc();
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toContain('name: julian-web-harness');
    expect(doc).toContain('## Surfaces');
    expect(doc).toContain('## Tools');
    expect(doc).toContain('## Services');
  });
  test('states the exact marker format line', () => {
    expect(buildRoomDoc()).toContain('[ACTION] {"target":"<target>","action":"<action>","data":{...}}');
  });
  test('lists built-in targets and registered targets', () => {
    expect(buildRoomDoc()).toContain('**agents**');
    registerUITarget({ target: 'test-target', description: 'a test surface', actions: [{ name: 'ping', description: 'ping it' }] });
    expect(buildRoomDoc()).toContain('**test-target**');
    expect(uiActionTargets.some(t => t.target === 'test-target')).toBe(true);
  });
  test('Tools section names julianscreen with --agent-doc', () => {
    const doc = buildRoomDoc();
    expect(doc).toContain('julianscreen');
    expect(doc).toContain('--agent-doc');
  });
  test('services: julian-broker replaces the direct agentmail entry', () => {
    const doc = buildRoomDoc();
    expect(doc).toContain('julian-broker');
    expect(doc).toContain('doors get verbs, never keys');
    expect(doc).toContain('https://julian-broker.julian-memory.workers.dev');
    expect(doc).not.toContain('Bearer key held by the harness');
  });
});
