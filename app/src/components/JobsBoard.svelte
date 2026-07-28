<!-- app/src/components/JobsBoard.svelte -->
<!--
  The jobs board. Pull-only: jobs are posted, interest is declared with a
  statement, and the one human control is Accept — there is no assign path,
  by design (design spec §3). Declining is complete; no nagging affordances.
-->
<script lang="ts">
  import { store } from '../lib/store';

  let jobs = $state(store.getTable('jobs'));
  let interest = $state(store.getTable('jobInterest'));
  store.addTableListener('jobs', () => { jobs = store.getTable('jobs'); });
  store.addTableListener('jobInterest', () => { interest = store.getTable('jobInterest'); });

  const interestsFor = (jobId: string) =>
    Object.entries(interest).filter(([, r]) => r.jobId === jobId);

  function accept(jobId: string) {
    store.setCell('jobs', jobId, 'status', 'taken');
  }
</script>

<section class="jobs-board">
  <h2>the board</h2>
  {#if Object.keys(jobs).length === 0}
    <p class="empty">No work on the board. That is a complete state.</p>
  {/if}
  {#each Object.entries(jobs) as [id, job]}
    <article>
      <header>
        <strong>{job.title}</strong>
        <span class="status">{job.status}</span>
      </header>
      <p>{job.description}</p>
      <footer>posted by {job.postedBy}</footer>
      {#each interestsFor(id) as [iid, row] (iid)}
        <blockquote>
          <em>{row.agentName}:</em> {row.statement}
          {#if job.status === 'open'}
            <button onclick={() => accept(id)}>accept</button>
          {/if}
        </blockquote>
      {/each}
    </article>
  {/each}
</section>

<style>
  .jobs-board {
    padding: 16px;
    overflow-y: auto;
    height: 100%;
    font-family: var(--font-ui);
    color: rgba(255, 255, 255, 0.85);
  }
  h2 {
    font-family: var(--font-terminal);
    font-size: 14px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--j-cyan);
    margin: 0 0 12px;
  }
  .empty {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
  }
  article {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 10px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: rgba(255, 255, 255, 0.5);
  }
  p { font-size: 13px; margin: 6px 0; }
  footer { font-size: 11px; color: rgba(255, 255, 255, 0.4); }
  blockquote {
    margin: 8px 0 0;
    padding: 6px 10px;
    border-left: 2px solid var(--j-cyan);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  button {
    margin-left: auto;
    height: 24px;
    padding: 0 10px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
  }
  button:hover { background: var(--j-cyan); color: #000; border-color: var(--j-cyan); }
</style>
