import type { ApiEnvelope } from './types.js';

export type QueryParams = Record<string, string | number | boolean | undefined>;

/** What gets persisted to `api_raw_responses` for every call (audit trail). */
export interface RawResponseRecord {
  source: 'api-football';
  endpoint: string;
  params: Record<string, string>;
  httpStatus: number;
  results: number | null;
  errors: unknown;
  response: unknown;
  fetchedAt: Date;
}

export interface RateLimitInfo {
  /** Requests left today for the plan */
  dailyRemaining: number | null;
  /** Requests left in the current minute */
  minuteRemaining: number | null;
}

export interface ApiResult<T> {
  data: T;
  envelope: ApiEnvelope<T>;
  meta: {
    endpoint: string;
    params: Record<string, string>;
    fetchedAt: Date;
    httpStatus: number;
    rateLimit: RateLimitInfo;
    rawResponseId: number | null;
  };
}

export type ApiFootballErrorKind = 'HTTP' | 'API' | 'QUOTA' | 'RATE_LIMIT' | 'NETWORK' | 'AUTH';

export class ApiFootballError extends Error {
  constructor(
    message: string,
    readonly kind: ApiFootballErrorKind,
    readonly endpoint: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiFootballError';
  }

  get retryable(): boolean {
    return this.kind === 'RATE_LIMIT' || this.kind === 'NETWORK' || (this.kind === 'HTTP' && this.details === 'server');
  }
}

export interface ApiFootballClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Max requests per minute (plan limit). Default 10. */
  requestsPerMinute?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Called with every successful raw response; may return the DB id of the stored row. */
  onRawResponse?: (rec: RawResponseRecord) => Promise<number | null | void> | number | null | void;
  onRequest?: (endpoint: string, params: Record<string, string>) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Low-level API-Football v3 client.
 * - rate limiting (sliding 60s window)
 * - retry with exponential backoff on 429 / 5xx / network / rateLimit errors
 * - API returns HTTP 200 with an `errors` object for logical errors -> converted to exceptions
 * - every response is handed to `onRawResponse` so it can be stored verbatim
 */
export class ApiFootballClient {
  private readonly baseUrl: string;
  private readonly rpm: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly calls: number[] = [];
  private _requestCount = 0;
  private _rejectedCount = 0;
  private _lastRateLimit: RateLimitInfo = { dailyRemaining: null, minuteRemaining: null };

  constructor(private readonly opts: ApiFootballClientOptions) {
    if (!opts.apiKey) throw new Error('ApiFootballClient: apiKey is required');
    this.baseUrl = (opts.baseUrl ?? 'https://v3.football.api-sports.io').replace(/\/+$/, '');
    this.rpm = opts.requestsPerMinute ?? 10;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    // wrap the global: Workers throw "Illegal invocation" when fetch is called as this.fetchImpl(...)
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Number of HTTP requests made (includes retries) — use to track API cost. */
  get requestCount(): number {
    return this._requestCount;
  }

  /** Requests the API refused for the per-minute rate limit. They do not count against the day's quota (checked against /status). */
  get rejectedCount(): number {
    return this._rejectedCount;
  }

  /** Requests that count against the day's quota: attempts minus the ones the API rate-limited. */
  get billedCount(): number {
    return this._requestCount - this._rejectedCount;
  }

  get lastRateLimit(): RateLimitInfo {
    return this._lastRateLimit;
  }

  async get<T>(endpoint: string, params: QueryParams = {}): Promise<ApiResult<T>> {
    const clean = cleanParams(params);
    let attempt = 0;
    for (;;) {
      try {
        return await this.request<T>(endpoint, clean);
      } catch (err) {
        const e = err instanceof ApiFootballError ? err : new ApiFootballError(String(err), 'NETWORK', endpoint, err);
        if (!e.retryable || attempt >= this.maxRetries) throw e;
        const backoff = Math.min(60_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        attempt += 1;
        await this.sleep(e.kind === 'RATE_LIMIT' ? Math.max(backoff, 15_000) : backoff);
      }
    }
  }

  /** Fetches every page (`paging.total`) and concatenates `response` arrays. */
  async getAllPages<T>(endpoint: string, params: QueryParams = {}, maxPages = 100): Promise<{ data: T[]; pages: ApiResult<T[]>[] }> {
    const pages: ApiResult<T[]>[] = [];
    const data: T[] = [];
    let page = 1;
    for (;;) {
      const res = await this.get<T[]>(endpoint, { ...params, page });
      pages.push(res);
      data.push(...res.data);
      const total = res.envelope.paging?.total ?? 1;
      if (page >= total || page >= maxPages) break;
      page += 1;
    }
    return { data, pages };
  }

  private async throttle(): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const t = this.now();
      while (this.calls.length && t - this.calls[0]! >= windowMs) this.calls.shift();
      if (this.calls.length < this.rpm) {
        this.calls.push(t);
        return;
      }
      await this.sleep(windowMs - (t - this.calls[0]!) + 50);
    }
  }

  private async request<T>(endpoint: string, params: Record<string, string>): Promise<ApiResult<T>> {
    await this.throttle();
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    this.opts.onRequest?.(path, params);
    this._requestCount += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'x-apisports-key': this.opts.apiKey, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApiFootballError(`Network error calling ${path}: ${String(err)}`, 'NETWORK', path, err);
    } finally {
      clearTimeout(timer);
    }

    this._lastRateLimit = {
      dailyRemaining: numHeader(res.headers, 'x-ratelimit-requests-remaining'),
      minuteRemaining: numHeader(res.headers, 'x-ratelimit-remaining'),
    };

    if (res.status === 429) {
      this._rejectedCount += 1;
      throw new ApiFootballError(`429 Too Many Requests on ${path}`, 'RATE_LIMIT', path);
    }
    if (res.status === 401 || res.status === 403) throw new ApiFootballError(`HTTP ${res.status} on ${path} (check API key)`, 'AUTH', path);
    if (res.status >= 500) throw new ApiFootballError(`HTTP ${res.status} on ${path}`, 'HTTP', path, 'server');
    if (!res.ok) throw new ApiFootballError(`HTTP ${res.status} on ${path}`, 'HTTP', path, await safeText(res));

    let body: ApiEnvelope<T>;
    try {
      body = (await res.json()) as ApiEnvelope<T>;
    } catch (err) {
      throw new ApiFootballError(`Invalid JSON from ${path}`, 'HTTP', path, 'server');
    }

    const errors = normaliseErrors(body.errors);
    if (errors) {
      const text = JSON.stringify(errors);
      if (/ratelimit|too many requests/i.test(text)) {
        this._rejectedCount += 1;
        throw new ApiFootballError(`Rate limited: ${text}`, 'RATE_LIMIT', path, errors);
      }
      if (/request limit|reached the request limit|plan/i.test(text)) throw new ApiFootballError(`Quota/plan: ${text}`, 'QUOTA', path, errors);
      if (/token|key/i.test(text)) throw new ApiFootballError(`Auth: ${text}`, 'AUTH', path, errors);
      throw new ApiFootballError(`API error on ${path}: ${text}`, 'API', path, errors);
    }

    const fetchedAt = new Date(this.now());
    let rawResponseId: number | null = null;
    if (this.opts.onRawResponse) {
      const id = await this.opts.onRawResponse({
        source: 'api-football',
        endpoint: path,
        params,
        httpStatus: res.status,
        results: typeof body.results === 'number' ? body.results : null,
        errors: body.errors,
        response: body,
        fetchedAt,
      });
      rawResponseId = typeof id === 'number' ? id : null;
    }

    return {
      data: body.response,
      envelope: body,
      meta: { endpoint: path, params, fetchedAt, httpStatus: res.status, rateLimit: this._lastRateLimit, rawResponseId },
    };
  }
}

function cleanParams(params: QueryParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    out[k] = String(v);
  }
  return out;
}

function numHeader(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** API returns `errors: []` when OK, or `{ field: "message" }` when not. */
function normaliseErrors(errors: unknown): Record<string, unknown> | unknown[] | null {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.length ? errors : null;
  if (typeof errors === 'object') return Object.keys(errors as object).length ? (errors as Record<string, unknown>) : null;
  return { error: errors };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
