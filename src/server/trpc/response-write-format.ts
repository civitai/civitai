import { AsyncLocalStorage } from 'node:async_hooks';
import { canDecodeDevalueResponse } from '~/server/utils/client-version-saturation';
import { pickServerWriteSerialize, WRITE_DEVALUE } from '~/shared/utils/trpc-union-transformer';

/**
 * Per-request choice of the tRPC HTTP response WRITE format (superjson vs devalue).
 *
 * tRPC hands the transformer only the payload, never the request, and the pool-wide
 * `TRPC_WRITE_DEVALUE` switch alone is unsafe: every non-web consumer of `/api/trpc`
 * (`@civitai/app-sdk`, `@civitai/blocks-react`, CLIs, scripts) and every web bundle older
 * than the union deserializer reads only the superjson `{ json, meta }` shape. So the route
 * (`src/pages/api/trpc/[trpc].ts`) seeds this request-scoped store from the request headers,
 * and the server transformer (`src/server/trpc.ts`) reads it at serialize time.
 *
 * The response is devalue only when ALL of these hold, superjson otherwise:
 *  1. `TRPC_WRITE_DEVALUE=true` on this pool (the master switch — off means no store at all);
 *  2. `canDecodeDevalueResponse(headers)` — a web bundle new enough to decode it;
 *  3. the response is NOT edge-cacheable (`pinResponseWriteToSuperjson`, called from the
 *     route's `responseMeta`). A cached body is served by URL to whoever asks next, and the
 *     CDN in front ignores `Vary` on these responses, so a cacheable response must be in the
 *     format every client reads. tRPC (v11 `resolveResponse`) calls `responseMeta` before it
 *     serializes the body on every path that can produce a cacheable response (single, batch,
 *     streamed batch), so the pin is in place in time. Its error path serializes first, but
 *     an errored response is never cacheable.
 *
 * Every response that stays devalue also leaves that same `responseMeta` with a non-shareable
 * `Cache-Control` (the private default, or `no-store` on a block-token query), so a shared cache
 * never stores one, whether or not the proxy middleware's default reaches the response.
 *
 * No store (switch off, incapable client, or code running outside an HTTP request) means
 * superjson — the safe direction, since every client reads it.
 */
type WriteFormatStore = { devalue: boolean };

const writeFormatStorage = new AsyncLocalStorage<WriteFormatStore>();

type RequestHeaders = Parameters<typeof canDecodeDevalueResponse>[0];

/**
 * Run `fn` (the tRPC handler) with this request's write format in scope. Creates a store only
 * when the response could be devalue, so superjson-only requests pay nothing beyond the
 * header check.
 */
export function runWithResponseWriteFormat<T>(headers: RequestHeaders, fn: () => T): T {
  if (!WRITE_DEVALUE || !canDecodeDevalueResponse(headers)) return fn();
  return writeFormatStorage.run({ devalue: true }, fn);
}

/** Whether the response being serialized in the current request will be devalue. */
export function responseWritesDevalue(): boolean {
  return writeFormatStorage.getStore()?.devalue === true;
}

/** Force the current request's response to superjson (an edge-cacheable response). */
export function pinResponseWriteToSuperjson(): void {
  const store = writeFormatStorage.getStore();
  if (store) store.devalue = false;
}

/**
 * The server transformer's response write. devalue goes through the fail-open
 * `writeSerializeWithFallback` (superjson for a payload devalue cannot represent).
 */
export function responseWriteSerialize(data: unknown): unknown {
  return pickServerWriteSerialize(responseWritesDevalue())(data);
}
