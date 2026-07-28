import { describe, expect, test } from 'bun:test';
import { buildRoomDoc, registerUITarget, uiActionTargets } from '../../server/room';

describe('room discovery document', () => {
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
});
