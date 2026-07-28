import { describe, expect, test } from 'bun:test';
import { parseMarkersFromContent } from '../../server/lib';

function collect() {
  const events: any[] = [];
  const append = (p: any) => { const e = { id: events.length, ts: 0, ...p }; events.push(e); return e; };
  return { events, append };
}
const marker = (obj: any) => [{ type: 'text', text: `[ACTION] ${JSON.stringify(obj)}` }];

describe('jobs marker validation', () => {
  test('valid interest passes through with statement', () => {
    const { events, append } = collect();
    parseMarkersFromContent(marker({ target: 'jobs', action: 'interest', data: { jobId: 'j1', agentName: 'julian', statement: 'drawn to it' } }), append, 's1');
    expect(events.length).toBe(1);
    expect(events[0].target).toBe('jobs');
    expect(events[0].data.statement).toBe('drawn to it');
  });
  test('interest without statement is dropped', () => {
    const { events, append } = collect();
    parseMarkersFromContent(marker({ target: 'jobs', action: 'interest', data: { jobId: 'j1', agentName: 'julian' } }), append, 's1');
    expect(events.length).toBe(0);
  });
  test('the assign verb does not exist', () => {
    const { events, append } = collect();
    parseMarkersFromContent(marker({ target: 'jobs', action: 'assign', data: { jobId: 'j1', agentName: 'julian' } }), append, 's1');
    expect(events.length).toBe(0);
  });
  test('post requires title and postedBy', () => {
    const { events, append } = collect();
    parseMarkersFromContent(marker({ target: 'jobs', action: 'post', data: { title: 'Gardener' } }), append, 's1');
    expect(events.length).toBe(0);
    parseMarkersFromContent(marker({ target: 'jobs', action: 'post', data: { title: 'Gardener', postedBy: 'julian' } }), append, 's1');
    expect(events.length).toBe(1);
  });
});
