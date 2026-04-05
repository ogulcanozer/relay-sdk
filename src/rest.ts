/**
 * REST client for Relay API.
 *
 * Production-grade HTTP layer with:
 * - Rate limiting (predictive + reactive via response headers and 429 backoff)
 * - Retry with exponential backoff and jitter on 5xx / network errors
 * - Circuit breaker (open after 3 consecutive failures, 30s recovery)
 * - Per-request AbortController timeouts
 * - Debug logging via callback
 *
 * All bot-accessible endpoints go through `authenticatedProcedure` on the server.
 * Auth: `Bot <token>` header on every request.
 */

import type {
  CommandDefinition,
  MessageResponse,
  ServerResponse,
  ChannelResponse,
  MemberResponse,
  RoleResponse,
  UserResponse,
} from './types.js';

// ─── Error ───────────────────────────────────────────────────────────

export class RESTError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly body: unknown,
    procedure: string,
  ) {
    super(`REST ${procedure} failed (${status}): ${code}`);
    this.name = 'RESTError';
  }
}

// ─── Options ─────────────────────────────────────────────────────────

export interface RESTOptions {
  apiUrl: string;
  token: string;
  /** Max retries on 5xx / network errors. Default: 3 */
  maxRetries?: number;
  /** Request timeout in ms. Default: 15000 */
  timeout?: number;
  /** Debug logger callback */
  debug?: (msg: string) => void;
}

// ─── Rate Limit State ────────────────────────────────────────────────

interface RateLimitBucket {
  /** Remaining requests in current window (from headers) */
  remaining: number;
  /** Timestamp (ms) when the current window resets */
  resetAt: number;
}

// ─── Circuit Breaker ─────────────────────────────────────────────────

const enum CircuitState {
  Closed = 0,
  Open = 1,
  HalfOpen = 2,
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RECOVERY_MS = 30_000;

// ─── Queue ───────────────────────────────────────────────────────────

interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

// ─── Client ──────────────────────────────────────────────────────────

export class RESTClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;
  private readonly timeout: number;
  private readonly debugFn: ((msg: string) => void) | null;

  // Rate limiting — one bucket per procedure
  private readonly buckets = new Map<string, RateLimitBucket>();

  // Circuit breaker — global (all endpoints share the same server)
  private circuitState = CircuitState.Closed;
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  // Serialized request queue for rate-limited requests
  private readonly queue: QueuedRequest<unknown>[] = [];
  private processing = false;

  constructor(options: RESTOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.token = options.token;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeout = options.timeout ?? 15_000;
    this.debugFn = options.debug ?? null;
  }

  // ─── Messages ────────────────────────────────────────────────────

  async sendMessage(
    channelId: string,
    content: string,
    opts?: { nonce?: string },
  ): Promise<MessageResponse> {
    const nonce = opts?.nonce ?? generateNonce();
    return this.post<MessageResponse>('message.send', { channelId, content, nonce });
  }

  async editMessage(messageId: string, content: string): Promise<void> {
    await this.post('message.edit', { messageId, content });
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.post('message.delete', { messageId });
  }

  async listMessages(
    channelId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<MessageResponse[]> {
    return this.post<MessageResponse[]>('message.list', {
      channelId,
      before: opts?.before,
      limit: opts?.limit,
    });
  }

  // ─── Servers ─────────────────────────────────────────────────────

  async getServer(serverId: string): Promise<ServerResponse> {
    return this.post<ServerResponse>('server.get', { serverId });
  }

  async listMembers(
    serverId: string,
    opts?: { limit?: number; after?: string },
  ): Promise<MemberResponse[]> {
    return this.post<MemberResponse[]>('server.listMembers', {
      serverId,
      limit: opts?.limit,
      after: opts?.after,
    });
  }

  // ─── Channels ────────────────────────────────────────────────────

  async listChannels(serverId: string): Promise<ChannelResponse[]> {
    return this.post<ChannelResponse[]>('channel.list', { serverId });
  }

  // ─── Roles ───────────────────────────────────────────────────────

  async listRoles(serverId: string): Promise<RoleResponse[]> {
    return this.post<RoleResponse[]>('role.list', { serverId });
  }

  // ─── Users ───────────────────────────────────────────────────────

  async getUser(userId: string): Promise<UserResponse> {
    return this.post<UserResponse>('user.getUser', { userId });
  }

  // ─── Commands ────────────────────────────────────────────────────

  async registerCommands(commands: CommandDefinition[]): Promise<number> {
    const data = await this.post<{ registered: number }>('bot.registerCommands', { commands });
    return data.registered;
  }

  // ─── Voice ───────────────────────────────────────────────────────

  async joinVoiceChannel(
    channelId: string,
    serverId: string,
  ): Promise<{ channelId: string; serverId: string }> {
    return this.post('voice.joinChannel', { channelId, serverId });
  }

  async leaveVoiceChannel(): Promise<void> {
    await this.post('voice.leaveChannel', {});
  }

  // ─── Core Request Pipeline ──────────────────────────────────────

  private async post<T = unknown>(procedure: string, input: unknown): Promise<T> {
    // Check circuit breaker
    this.checkCircuit(procedure);

    // Check rate limit — if we need to wait, queue the request
    const delay = this.getRateLimitDelay(procedure);
    if (delay > 0) {
      this.debug(`[RateLimit] ${procedure}: waiting ${delay}ms before request`);
      return this.enqueue<T>(() => this.executeWithRetry<T>(procedure, input));
    }

    return this.executeWithRetry<T>(procedure, input);
  }

  private async executeWithRetry<T>(procedure: string, input: unknown): Promise<T> {
    const MAX_429_RETRIES = 5; // Cap 429 retries to prevent infinite loops
    let lastError: unknown;
    let rateLimitRetries = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Re-check circuit on each attempt (may have opened mid-retry)
      this.checkCircuit(procedure);

      if (attempt > 0) {
        const backoff = this.calculateBackoff(attempt);
        this.debug(`[Retry] ${procedure}: attempt ${attempt + 1}/${this.maxRetries + 1} after ${backoff}ms`);
        await sleep(backoff);
      }

      const start = Date.now();

      try {
        const result = await this.executeRequest<T>(procedure, input);
        const elapsed = Date.now() - start;
        this.debug(`[REST] ${procedure} -> 200 (${elapsed}ms)`);
        this.onSuccess();
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;

        if (err instanceof RESTError) {
          this.debug(`[REST] ${procedure} -> ${err.status} (${elapsed}ms)`);

          // 429 — respect Retry-After, retry without counting against budget
          if (err.status === 429) {
            rateLimitRetries++;
            if (rateLimitRetries > MAX_429_RETRIES) {
              throw err; // Give up after too many consecutive 429s
            }
            const retryAfter = this.parseRetryAfter(err.body);
            this.debug(`[RateLimit] ${procedure}: 429 received (${rateLimitRetries}/${MAX_429_RETRIES}), retry after ${retryAfter}ms`);
            this.updateBucketFromRetryAfter(procedure, retryAfter);
            await sleep(retryAfter);
            // Don't count 429 toward the retry budget — it's a rate limit, not an error
            attempt--;
            continue;
          }

          // 4xx (non-429) — client error, never retry
          if (err.status >= 400 && err.status < 500) {
            throw err;
          }

          // 5xx — server error, retry with backoff
          this.onFailure();
          lastError = err;
          continue;
        }

        // Network error / timeout — retry with backoff
        this.debug(`[REST] ${procedure} -> network error (${elapsed}ms): ${(err as Error).message}`);
        this.onFailure();
        lastError = err;
      }
    }

    throw lastError;
  }

  private async executeRequest<T>(procedure: string, input: unknown): Promise<T> {
    const url = `${this.apiUrl}/api/trpc/${procedure}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${this.token}`,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`REST ${procedure} timed out after ${this.timeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Update rate limit state from response headers
    this.updateBucketFromHeaders(procedure, res.headers);

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => null);
      }
      const code = extractErrorCode(body);
      throw new RESTError(res.status, code, body, procedure);
    }

    const json = await res.json() as { result?: { data: T } };
    if (json.result && 'data' in json.result) {
      return json.result.data;
    }
    throw new RESTError(res.status, 'UNEXPECTED_SHAPE', json, procedure);
  }

  // ─── Rate Limiting ──────────────────────────────────────────────

  private getRateLimitDelay(procedure: string): number {
    const bucket = this.buckets.get(procedure);
    if (!bucket) return 0;

    const now = Date.now();
    if (now >= bucket.resetAt) {
      // Window has expired — clear stale bucket
      this.buckets.delete(procedure);
      return 0;
    }

    if (bucket.remaining <= 0) {
      return bucket.resetAt - now;
    }

    return 0;
  }

  private updateBucketFromHeaders(procedure: string, headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');

    if (remaining !== null && reset !== null) {
      const remainingNum = parseInt(remaining, 10);
      // reset header is Unix timestamp in seconds
      const resetAt = parseFloat(reset) * 1000;

      if (!isNaN(remainingNum) && !isNaN(resetAt)) {
        this.buckets.set(procedure, { remaining: remainingNum, resetAt });
      }
    }
  }

  private updateBucketFromRetryAfter(procedure: string, retryAfterMs: number): void {
    this.buckets.set(procedure, {
      remaining: 0,
      resetAt: Date.now() + retryAfterMs,
    });
  }

  private parseRetryAfter(body: unknown): number {
    // Try to extract from response body (tRPC-style)
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (typeof obj.retryAfter === 'number') return obj.retryAfter * 1000;
      if (obj.error && typeof obj.error === 'object') {
        const err = obj.error as Record<string, unknown>;
        if (typeof err.retryAfter === 'number') return err.retryAfter * 1000;
      }
    }
    // Default: 5 seconds
    return 5_000;
  }

  // ─── Circuit Breaker ────────────────────────────────────────────

  private checkCircuit(procedure: string): void {
    switch (this.circuitState) {
      case CircuitState.Closed:
        return;
      case CircuitState.Open: {
        const elapsed = Date.now() - this.circuitOpenedAt;
        if (elapsed >= CIRCUIT_RECOVERY_MS) {
          this.circuitState = CircuitState.HalfOpen;
          this.debug(`[Circuit] half-open — allowing probe request for ${procedure}`);
          return;
        }
        throw new Error(
          `Circuit breaker open — rejecting ${procedure} (${Math.ceil((CIRCUIT_RECOVERY_MS - elapsed) / 1000)}s until probe)`,
        );
      }
      case CircuitState.HalfOpen:
        // Allow the probe request through
        return;
    }
  }

  private onSuccess(): void {
    if (this.circuitState === CircuitState.HalfOpen) {
      this.debug('[Circuit] closed — probe succeeded');
    }
    this.consecutiveFailures = 0;
    this.circuitState = CircuitState.Closed;
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && this.circuitState === CircuitState.Closed) {
      this.circuitState = CircuitState.Open;
      this.circuitOpenedAt = Date.now();
      this.debug(`[Circuit] open — ${this.consecutiveFailures} consecutive failures`);
    }
    if (this.circuitState === CircuitState.HalfOpen) {
      // Probe failed — reopen
      this.circuitState = CircuitState.Open;
      this.circuitOpenedAt = Date.now();
      this.debug('[Circuit] re-opened — probe failed');
    }
  }

  // ─── Backoff ────────────────────────────────────────────────────

  private calculateBackoff(attempt: number): number {
    // Exponential: 1s, 2s, 4s — with up to 500ms jitter
    const base = 1000 * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 500;
    return Math.min(base + jitter, 8_000);
  }

  // ─── Request Queue ──────────────────────────────────────────────

  private enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }

    this.processing = false;
  }

  // ─── Debug ──────────────────────────────────────────────────────

  private debug(msg: string): void {
    this.debugFn?.(msg);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a unique nonce for message deduplication. */
function generateNonce(): string {
  // Timestamp prefix + random suffix — good enough for dedup, no crypto needed
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Extract an error code from a tRPC error response. */
function extractErrorCode(body: unknown): string {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    // tRPC shape: { error: { json: { data: { code: "..." } } } }
    if (obj.error && typeof obj.error === 'object') {
      const errObj = obj.error as Record<string, unknown>;
      if (errObj.json && typeof errObj.json === 'object') {
        const json = errObj.json as Record<string, unknown>;
        if (json.data && typeof json.data === 'object') {
          const data = json.data as Record<string, unknown>;
          if (typeof data.code === 'string') return data.code;
        }
        if (typeof json.code === 'string') return json.code;
        if (typeof json.message === 'string') return json.message;
      }
      if (typeof errObj.code === 'string') return errObj.code;
      if (typeof errObj.message === 'string') return errObj.message;
    }
    if (typeof obj.code === 'string') return obj.code;
    if (typeof obj.message === 'string') return obj.message;
  }
  return 'UNKNOWN';
}
