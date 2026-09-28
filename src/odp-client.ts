import { LIMITS, type Region } from "./settings.js";

/** Credentials and target for one client, taken from its request headers. */
export interface OdpConnection {
  apiKey: string;
  region: Region;
  host: string;
}

export type QueryValue = string | number | boolean | undefined;

export interface RestRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export class OdpApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(`ODP API ${method} ${url} failed with HTTP ${status}`);
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export class OdpClient {
  constructor(readonly connection: OdpConnection) {}

  async rest<T = unknown>({ method = "GET", path, query, body }: RestRequest): Promise<T> {
    const url = new URL(`${this.connection.host}/v3${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.send<T>(method, url, body);
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>, operationName?: string) {
    const url = new URL(`${this.connection.host}/v3/graphql`);
    return this.send<GraphQLResponse<T>>("POST", url, { query, variables, operationName });
  }

  private async send<T>(method: string, url: URL, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "x-api-key": this.connection.apiKey,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") throw err;
        // undici reports network failures as a bare "fetch failed"; the useful part (ECONNREFUSED, ENOTFOUND, ...) is in `cause`.
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        throw new Error(`could not reach ODP at ${url.origin}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
      }

      if (RETRYABLE.has(res.status) && attempt < LIMITS.maxRetries) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }

      const text = await res.text();
      const parsed = parseBody(text);
      if (!res.ok) throw new OdpApiError(res.status, method, redact(url), parsed);
      return parsed as T;
    }
  }
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: unknown[]; extensions?: Record<string, unknown> }>;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 10_000);
  return 250 * 2 ** attempt + Math.random() * 100;
}

/** Strips query string values from URLs used in error messages (they can contain customer identifiers). */
function redact(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
