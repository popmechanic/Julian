// The browser side of the exchange flow (spec §6.1-§6.3): trades a Pocket ID
// JWT for an hour-scale `jla_` access token, then a 60s single-use `jst_`
// socket ticket — built against the wire contract (Global Constraints), not
// the broker's implementation. Nothing here ever touches localStorage: the
// cache lives in memory only, for the lifetime of this instance.

export type ExchangeState =
  | { kind: 'ok'; accessToken: string; expiresAt: number }
  | { kind: 'revoked' }
  | { kind: 'signed-out' }
  | { kind: 'retry'; after: number }
  | { kind: 'error' };

export type ExchangeStateNonOk = Exclude<ExchangeState, { kind: 'ok' }>;

interface ExchangeClientOptions {
  gateUrl: string;
  getJwt: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

// Re-mint once fewer than 5 minutes of life remain, so a request never races
// expiry mid-flight.
const ACCESS_MARGIN_MS = 5 * 60 * 1000;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export class ExchangeClient {
  private readonly gateUrl: string;
  private readonly getJwt: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<ExchangeState> | null = null;
  private isRevoked = false;
  private backoff = BACKOFF_START_MS;
  private terminal = 0;

  constructor(opts: ExchangeClientOptions) {
    this.gateUrl = opts.gateUrl.replace(/\/$/, '');
    this.getJwt = opts.getJwt;
    // Never store the bare global: browsers brand-check fetch's receiver, so
    // `this.fetchImpl(...)` on the raw function throws `Illegal invocation`
    // before any network dispatch. The lambda also late-binds, so a harness
    // that patches window.fetch after module load is still observed.
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /** Consecutive terminal-shaped failures (`revoked` or `error`), reset by any other outcome. */
  terminalCount(): number {
    return this.terminal;
  }

  /** Clears the cache and the revoked latch. A human act (§6.5): explicit reload or sign-in. */
  reset(): void {
    this.cached = null;
    this.isRevoked = false;
    this.backoff = BACKOFF_START_MS;
    this.terminal = 0;
  }

  async access(): Promise<ExchangeState> {
    if (this.isRevoked) return this.revokedState();

    if (this.cached && this.cached.expiresAt - Date.now() > ACCESS_MARGIN_MS) {
      return this.okState(this.cached.token, this.cached.expiresAt);
    }

    // Concurrent callers share one mint: two access() calls must never cost
    // two leases (the session cap counts them).
    if (!this.inflight) {
      this.inflight = this.mintAccess().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async mintAccess(): Promise<ExchangeState> {
    const jwt = await this.getJwt();
    if (!jwt) return this.signedOutState();

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.gateUrl}/exchange`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      });
    } catch {
      return this.retryState();
    }
    return this.handleExchangeResponse(res);
  }

  async ticket(): Promise<{ ticket: string } | ExchangeStateNonOk> {
    const first = await this.access();
    if (first.kind !== 'ok') return first;

    const r1 = await this.mintTicket(first.accessToken);
    if (r1 !== 'need-reexchange') return r1;

    // Token died early: drop the cache and re-exchange once, silently.
    // Only `revoked` is terminal — an expired-early access token just
    // re-mints, the same as a naturally expired one.
    this.cached = null;
    const second = await this.access();
    if (second.kind !== 'ok') return second;

    const r2 = await this.mintTicket(second.accessToken);
    if (r2 === 'need-reexchange') return this.errorState(); // no second silent retry
    return r2;
  }

  private async handleExchangeResponse(res: Response): Promise<ExchangeState> {
    if (res.status === 200) {
      const body = (await res.json()) as { access_token: string; expires_in: number };
      const expiresAt = Date.now() + body.expires_in * 1000;
      this.cached = { token: body.access_token, expiresAt };
      return this.okState(body.access_token, expiresAt);
    }

    const errClass = await this.readClass(res);
    if (errClass === 'revoked') return this.revokedState();
    if (errClass === 'rate' || errClass === 'session-cap' || res.status === 429) return this.retryState();
    if (res.status >= 500) return this.retryState(); // includes 503 no-audience: an outage, not a refusal
    return this.errorState();
  }

  private async mintTicket(accessToken: string): Promise<{ ticket: string } | ExchangeStateNonOk | 'need-reexchange'> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.gateUrl}/socket-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      return this.retryState();
    }

    if (res.status === 200) {
      const body = (await res.json()) as { ticket: string };
      this.terminal = 0;
      return { ticket: body.ticket };
    }
    if (res.status === 401) return 'need-reexchange';

    const errClass = await this.readClass(res);
    if (errClass === 'rate' || res.status === 429) return this.retryState();
    if (res.status >= 500) return this.retryState();
    return this.errorState();
  }

  private async readClass(res: Response): Promise<string | undefined> {
    try {
      const body = (await res.json()) as { class?: string };
      return body.class;
    } catch {
      return undefined;
    }
  }

  private okState(accessToken: string, expiresAt: number): ExchangeState {
    this.terminal = 0;
    this.backoff = BACKOFF_START_MS;
    return { kind: 'ok', accessToken, expiresAt };
  }

  private signedOutState(): ExchangeStateNonOk {
    this.terminal = 0;
    return { kind: 'signed-out' };
  }

  private retryState(): ExchangeStateNonOk {
    const after = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_CAP_MS);
    this.terminal = 0;
    return { kind: 'retry', after };
  }

  private errorState(): ExchangeStateNonOk {
    this.terminal += 1;
    return { kind: 'error' };
  }

  private revokedState(): ExchangeStateNonOk {
    if (!this.isRevoked) this.terminal += 1; // count the latch itself once — reads of a latched state are not new outcomes (#34)
    this.isRevoked = true;
    this.cached = null;
    return { kind: 'revoked' };
  }
}
