<!-- app/src/components/SetupScreen.svelte -->
<!-- Gate screen: passkey sign-in when signed out, then the Anthropic OAuth -->
<!-- handshake when health reports needsSetup. Calls onReady once both are clear. -->
<script lang="ts">
  import { fetchHealth } from '../lib/api';
  import { isSignedIn, signIn, authEnabled, getToken } from '../lib/auth';

  let { onReady }: { onReady: () => void } = $props();

  let needsSetup = $state(false);
  let checking = $state(true);
  const signedIn = isSignedIn();
  let oauthUrl = $state<string | null>(null);
  let code = $state('');
  let error = $state<string | null>(null);

  $effect(() => {
    fetchHealth().then((h) => {
      needsSetup = h.needsSetup;
      checking = false;
    });
  });

  $effect(() => {
    if (!checking && !needsSetup && signedIn) onReady();
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
  <div class="setup"><div class="panel wait">CHECKING THE HOUSE…</div></div>
{:else if !signedIn && authEnabled()}
  <div class="setup">
    <div class="head">
      <h1>SIGN IN</h1>
      <p>JULIAN'S HOUSE HAS A LOCK — YOUR PASSKEY IS THE KEY</p>
    </div>
    <div class="panel">
      <button class="primary" onclick={signIn}>SIGN IN WITH PASSKEY</button>
    </div>
  </div>
{:else if needsSetup}
  <div class="setup">
    <div class="head">
      <h1>CONNECT TO CLAUDE</h1>
      <p>ONE-TIME SETUP TO LINK YOUR ACCOUNT</p>
    </div>
    <div class="panel">
      <div class="step">&gt; STEP 1: AUTHORIZE WITH ANTHROPIC</div>
      <p class="copy">OPENS ANTHROPIC IN A NEW TAB. AUTHORIZE, THEN COPY THE SHORT CODE BACK HERE.</p>
      <button class="primary" onclick={beginOauth}>SIGN IN WITH ANTHROPIC</button>
      {#if oauthUrl}
        <div class="step">&gt; STEP 2: PASTE AUTHORIZATION CODE</div>
        <input bind:value={code} placeholder="PASTE CODE HERE..." />
        <button class="primary" onclick={exchange}>COMPLETE</button>
      {/if}
      {#if error}<p class="error">{error}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .setup {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 24px;
  }
  .head { text-align: center; }
  h1 {
    font-family: var(--font-terminal);
    font-size: 2rem;
    color: #000;
    margin: 16px 0 0;
    text-transform: uppercase;
    letter-spacing: 0.15em;
  }
  .head p { font-family: var(--font-terminal); font-size: 1.1rem; color: var(--j-gray-555); margin-top: 4px; }
  .panel {
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-radius: 12px;
    box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.5);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(480px, 100%);
  }
  .panel.wait { color: var(--j-yellow); font-family: var(--font-terminal); text-align: center; animation: blink 1.4s step-end infinite; }
  .step { font-family: var(--font-terminal); font-size: 1.1rem; color: var(--j-yellow); }
  .copy { font-family: var(--font-terminal); font-size: 1rem; color: var(--j-yellow-dim); line-height: 1.5; margin: 0; }
  .primary {
    padding: 14px 32px;
    border-radius: 8px;
    background: var(--j-yellow);
    color: #000;
    border: none;
    font-family: var(--font-terminal);
    font-size: 1.3rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    box-shadow: 0 4px 0 var(--j-yellow-dim), 0 8px 10px rgba(0, 0, 0, 0.15);
    transition: background-color 100ms ease, box-shadow 100ms ease;
  }
  .primary:active { transform: translateY(4px); box-shadow: none; }
  input {
    width: 100%;
    background-color: var(--j-yellow-key);
    box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.15), inset -1px -1px 2px rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #000;
    font-weight: bold;
    padding: 0 16px;
    height: 50px;
    font-family: var(--font-terminal);
    font-size: 1.1rem;
    border: 2px solid transparent;
    outline: none;
  }
  .error { font-family: var(--font-terminal); font-size: 1rem; color: var(--j-red); }
</style>
