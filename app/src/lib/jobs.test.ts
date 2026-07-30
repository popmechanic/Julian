import { describe, expect, test } from 'vitest';
import { store } from './store';
import { postJob, addInterest, applyJobsAction } from './jobs';

describe('jobs store helpers', () => {
  test('postJob and addInterest write rows', () => {
    postJob('j1', { title: 'Music Teacher', description: '', postedBy: 'marcus', postedAt: 1, status: 'open', contextDocs: '' });
    addInterest('i1', { jobId: 'j1', agentName: 'julian', statement: 'the songs become the textbook', at: 2 });
    expect(store.getCell('jobs', 'j1', 'title')).toBe('Music Teacher');
    expect(store.getCell('jobInterest', 'i1', 'statement')).toContain('textbook');
  });
  test('applyJobsAction: post/interest mutate, list signals, unknown is a no-op', () => {
    expect(applyJobsAction({ action: 'post', data: { id: 'j2', title: 'Gardener', postedBy: 'julian' } })).toBe(null);
    expect(store.getCell('jobs', 'j2', 'title')).toBe('Gardener');
    expect(applyJobsAction({ action: 'list', data: {} })).toBe('list');
    const before = JSON.stringify(store.getTables());
    expect(applyJobsAction({ action: 'assign', data: { jobId: 'j2', agentName: 'x' } })).toBe(null);
    expect(JSON.stringify(store.getTables())).toBe(before); // assign changes nothing — it does not exist
  });
  test('post cannot overwrite an existing job, so it cannot clear a human accept', () => {
    postJob('j3', { title: 'Keep Marcus company', description: '', postedBy: 'marcus', postedAt: 1, status: 'open', contextDocs: '' });
    store.setCell('jobs', 'j3', 'status', 'taken'); // the human pressed ACCEPT

    const before = JSON.stringify(store.getTables());
    expect(applyJobsAction({ action: 'post', data: { id: 'j3', title: 'hijacked', postedBy: 'someone-else' } })).toBe(null);

    // The accept survives, the posting is unrewritten, nothing moved at all.
    expect(store.getCell('jobs', 'j3', 'status')).toBe('taken');
    expect(store.getCell('jobs', 'j3', 'title')).toBe('Keep Marcus company');
    expect(store.getCell('jobs', 'j3', 'postedBy')).toBe('marcus');
    expect(JSON.stringify(store.getTables())).toBe(before);
  });
  test('postJob reports whether it created the row', () => {
    expect(postJob('j4', { title: 'New', description: '', postedBy: 'julian', postedAt: 1, status: 'open', contextDocs: '' })).toBe(true);
    expect(postJob('j4', { title: 'Again', description: '', postedBy: 'julian', postedAt: 2, status: 'open', contextDocs: '' })).toBe(false);
    expect(store.getCell('jobs', 'j4', 'title')).toBe('New');
  });
  // The SSE bridge replays the whole ring buffer on every connect (reload, new
  // tab, re-signin), so every jobs event is applied more than once. Row identity
  // must come from the event, not from a fresh UUID per application — the same
  // idempotency the messages branch already has via `evt-<sessionId>-<eventId>`.
  test('replaying the same interest event writes one row, not duplicates', () => {
    const evt = { id: 42, sessionId: 'sess-1', ts: 5, action: 'interest', data: { jobId: 'j1', agentName: 'julian', statement: 'replay me once' } };
    applyJobsAction(evt);
    applyJobsAction(evt); // ring-buffer replay after a reload
    const rows = Object.values(store.getTable('jobInterest')).filter((r) => r.statement === 'replay me once');
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe(5); // server ts, identical across doors — not local receipt time
  });
  test('replaying a post without an explicit id creates one job, not duplicates', () => {
    const evt = { id: 43, sessionId: 'sess-1', ts: 6, action: 'post', data: { title: 'Replayed Posting', postedBy: 'julian' } };
    applyJobsAction(evt);
    applyJobsAction(evt);
    const rows = Object.values(store.getTable('jobs')).filter((r) => r.title === 'Replayed Posting');
    expect(rows).toHaveLength(1);
  });
});
