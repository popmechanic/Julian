<!-- app/src/components/SetupScreen.svelte -->
<!-- Gate screen: Clerk sign-in when signed out, then the Anthropic OAuth -->
<!-- handshake when health reports needsSetup. Calls onReady once both are clear. -->
<script lang="ts">
  import { fetchHealth } from '../lib/api';
  import { isSignedIn, clerkInstance, getToken } from '../lib/clerk';

  let { onReady }: { onReady: () => void } = $props();

  let needsSetup = $state(false);
  let checking = $state(true);
  let signedIn = $state(isSignedIn());
  let oauthUrl = $state<string | null>(null);
  let code = $state('');
  let error = $state<string | null>(null);
  let clerkMount: HTMLDivElement | undefined = $state();

  $effect(() => {
    fetchHealth().then((h) => {
      needsSetup = h.needsSetup;
      checking = false;
    });
  });

  // isSignedIn() is a plain call — without subscribing to Clerk's state the
  // screen would never advance after a successful sign-in.
  $effect(() => {
    const clerk = clerkInstance();
    if (!clerk) return;
    return clerk.addListener(() => {
      signedIn = !!clerk.user;
    });
  });

  $effect(() => {
    if (!checking && !needsSetup && (signedIn || !clerkInstance())) onReady();
  });

  $effect(() => {
    const clerk = clerkInstance();
    if (clerk && !signedIn && clerkMount) clerk.mountSignIn(clerkMount);
  });

  async function authHeaders(): Promise<Record<string, string>> {
    const t = await getToken();
    return t
      ? { Authorization: `Bearer ${t}`, 'X-Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }

  async function beginOauth() {
    error = null;
    const res = await fetch('/api/oauth/start', { headers: await authHeaders() });
    if (!res.ok) { error = `Sign-in failed to start (${res.status})`; return; }
    const body = (await res.json()) as { authUrl: string; state: string };
    oauthUrl = body.authUrl;
    sessionStorage.setItem('oauth-state', body.state);
    window.open(body.authUrl, '_blank');
  }

  async function exchange() {
    error = null;
    const res = await fetch('/api/oauth/exchange', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ code: code.trim(), state: sessionStorage.getItem('oauth-state') }),
    });
    if (res.ok) {
      needsSetup = false;
      onReady();
    } else {
      error = `Exchange failed (${res.status})`;
    }
  }
</script>

{#if checking}
  <div class="setup">Checking the house…</div>
{:else if !signedIn && clerkInstance()}
  <div class="setup">
    <div bind:this={clerkMount}></div>
  </div>
{:else if needsSetup}
  <div class="setup">
    <h2>Sign in with Anthropic</h2>
    <button onclick={beginOauth}>Open sign-in</button>
    {#if oauthUrl}
      <label>
        Paste the code you receive:
        <input bind:value={code} />
      </label>
      <button onclick={exchange}>Complete</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </div>
{/if}

<style>
  .setup {
    display: grid;
    place-items: center;
    height: 100%;
    gap: 1rem;
    text-align: center;
  }
  .error {
    color: #e66;
  }
</style>
