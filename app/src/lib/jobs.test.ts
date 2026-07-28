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
});
