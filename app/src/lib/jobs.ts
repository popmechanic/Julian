// The jobs board store bridge. Offered, never assigned: there is no assign path.
import { store } from './store';

export interface JobRow { title: string; description: string; postedBy: string; postedAt: number; status: string; contextDocs: string }
export interface InterestRow { jobId: string; agentName: string; statement: string; at: number }

export function postJob(id: string, row: JobRow): void {
  store.setRow('jobs', id, row as unknown as Record<string, string | number>);
}
export function addInterest(id: string, row: InterestRow): void {
  store.setRow('jobInterest', id, row as unknown as Record<string, string | number>);
}
export function withdrawInterest(jobId: string, agentName: string): void {
  const table = store.getTable('jobInterest');
  for (const [rowId, row] of Object.entries(table)) {
    if (row.jobId === jobId && row.agentName === agentName) store.delRow('jobInterest', rowId);
  }
}

export function applyJobsAction(e: { action?: unknown; data?: any }): 'list' | null {
  const d = e.data ?? {};
  switch (e.action) {
    case 'post':
      postJob(String(d.id ?? crypto.randomUUID()), {
        title: String(d.title ?? ''), description: String(d.description ?? ''),
        postedBy: String(d.postedBy ?? ''), postedAt: Date.now(),
        status: 'open', contextDocs: String(d.contextDocs ?? ''),
      });
      return null;
    case 'interest':
      addInterest(crypto.randomUUID(), {
        jobId: String(d.jobId ?? ''), agentName: String(d.agentName ?? ''),
        statement: String(d.statement ?? ''), at: Date.now(),
      });
      return null;
    case 'withdraw':
      withdrawInterest(String(d.jobId ?? ''), String(d.agentName ?? ''));
      return null;
    case 'list':
      return 'list';
    default:
      return null; // unknown actions (including assign) change nothing
  }
}
