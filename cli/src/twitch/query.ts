import { setTimeout as delay } from "node:timers/promises";

export const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
export const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

/** Error raised by the shared Twitch GraphQL transport. */
export class GqlQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GqlQueryError";
  }
}

export interface GqlQueryOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  /**
   * Maps a GraphQL `errors` array to the error to throw. Return a
   * GqlQueryError to stop immediately; the default reports that Twitch's
   * internal API may have changed.
   */
  graphqlErrors?: (errors: unknown[]) => GqlQueryError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GqlQueryError("INVALID_DATA", "Twitch returned an unexpected GraphQL payload.");
  }
  return value;
}

/**
 * POST a Twitch GraphQL body with bounded retries. Retries network failures,
 * 429 and 5xx responses with backoff and Retry-After support. A 4xx response,
 * a GraphQL rejection or an invalid payload stops immediately.
 */
export async function queryTwitchGql(
  body: unknown,
  options: GqlQueryOptions = {},
): Promise<Record<string, unknown>> {
  const attempts = options.attempts ?? 4;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    let waitMs = (options.retryDelayMs ?? 500) * 2 ** attempt;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      const response = await (options.fetch ?? fetch)(TWITCH_GQL_URL, {
        method: "POST",
        headers: { "Client-ID": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status !== 429 && response.status < 500) {
          throw new GqlQueryError("HTTP_ERROR", `Twitch returned HTTP ${response.status}.`);
        }
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(requested)) waitMs = Math.max(waitMs, Math.min(60_000, requested));
        }
        throw new Error(`Twitch returned HTTP ${response.status}.`);
      }
      const payload = record(await response.json());
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        throw (
          options.graphqlErrors?.(payload.errors) ??
          new GqlQueryError(
            "GRAPHQL_ERROR",
            "Twitch rejected the GraphQL request. Its internal API may have changed.",
          )
        );
      }
      return record(payload.data);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof GqlQueryError) throw error;
      lastError = error;
    }
    if (attempt + 1 < attempts) await delay(waitMs, undefined, { signal: options.signal });
  }
  throw new GqlQueryError(
    "NETWORK_ERROR",
    lastError instanceof Error ? lastError.message : "Twitch request failed.",
  );
}
