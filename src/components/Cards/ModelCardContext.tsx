import type { SaleDiscountKind } from '@civitai/buzz';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useRef } from 'react';
import { MODEL_SALE_IDS_PER_REQUEST } from '~/server/schema/model-sale.schema';
import { chunkIds } from '~/utils/array-helpers';
import { isAuthedBrowser, trpc, trpcVanilla } from '~/utils/trpc';
import { scheduleBatcherFlush } from '~/utils/trpc-batch-window';

/**
 * `discountType` is `SaleDiscountKind` from the package the server declares this procedure's output
 * with, not a local `'Fixed' | 'Percent'` restatement — the merge below is only type-checked by the
 * `as` on it, so a restatement would silently narrow away a third member the server had added.
 */
type ModelSale = { endsAt: Date; discountType: SaleDiscountKind; discountAmount: number };
type SalesByModelId = Record<number, ModelSale>;

/**
 * 🔴 RE-APPLY THE END EDGE ON THE CLIENT. The server evaluates both edges of the window against
 * `now` per request, but the client holds the answer: an arrival-order chunk key is stable once its
 * block is full, so a feed that stays mounted can keep serving a resolved map. `endsAt` was on the
 * wire already and NOTHING branched on it — the badge only ever formatted it — so a sale that ended
 * kept advertising a discount that the model page and the charge path both refuse.
 *
 * Re-wrapped rather than compared directly: `endsAt` arrives as a `Date` or an ISO string depending
 * on the response serializer, which is why `ModelVersionSaleBadge` types it `Date | string` too.
 */
const stillRunning = (sale: ModelSale, now: number) => new Date(sale.endsAt).getTime() > now;

const runningSalesOnly = (sales: SalesByModelId, now: number): SalesByModelId =>
  Object.fromEntries(Object.entries(sales).filter(([, sale]) => stillRunning(sale, now)));

type Context = {
  useModelVersionRedirect?: boolean;
  activeBaseModels?: string[];
  /** Set by a container that supplies the map, so cards do not each fetch their own. */
  hasSaleProvider?: boolean;
  /** modelId -> its running sale. Absent means no sale. */
  salesByModelId?: SalesByModelId;
};

const ModelCardContext = createContext<Context | null>(null);

export const useModelCardContext = () => {
  const context = useContext(ModelCardContext);
  return context ?? {};
};

/**
 * One lookup per page of cards, not one per card, and deliberately not part of the model query: the feed
 * query is a hot path and a sale is time-varying, so indexing it would mean re-indexing at every window
 * edge. Same shape as how cosmetics and version images are already fetched after the fact.
 */
/**
 * How long the single-card batcher waits after the FIRST id before asking. Cards on one surface mount
 * in one commit, but a page of home blocks or a related-models row resolves its own data at different
 * moments, so a few tens of ms folds several of those surfaces into one request. The badge already
 * appears a beat after its card; this adds at most this much to that beat.
 */
export const MODEL_SALE_BATCH_WINDOW_MS = 50;

/**
 * Test/injection seam, same shape as the engaged-models batcher in `~/hooks/useEngagedModelMembership`.
 * Production asks the vanilla client and flushes on a timer; a test swaps in a recorder.
 */
export const modelSaleBatcher = {
  fetch: (ids: number[]) => trpcVanilla.model.getActiveSales.query({ ids }),
  schedule: (cb: () => void): void => {
    scheduleBatcherFlush(cb, MODEL_SALE_BATCH_WINDOW_MS);
  },
};

type SaleWaiter = { resolve: (sale: ModelSale | null) => void; reject: (error: unknown) => void };
const pendingSales = new Map<number, SaleWaiter[]>();
let saleFlushScheduled = false;

function flushSales() {
  saleFlushScheduled = false;
  const waiting = new Map(pendingSales);
  pendingSales.clear();
  // Same chunk as the provider path, so one flush can never exceed the procedure's cap.
  for (const ids of chunkIds([...waiting.keys()], MODEL_SALE_IDS_PER_REQUEST)) {
    // Sent SYNCHRONOUSLY, so a flush released by the shared batch window (`trpcUnifiedBatchWindow`)
    // reaches the batch link inside that release and shares its request. A fetch that throws
    // synchronously still rejects this chunk's waiters instead of aborting the loop and leaving this
    // and every later chunk's cards pending forever.
    let request: ReturnType<typeof modelSaleBatcher.fetch>;
    try {
      request = modelSaleBatcher.fetch(ids);
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (sales) => {
        const byId = (sales ?? {}) as SalesByModelId;
        for (const id of ids) for (const w of waiting.get(id) ?? []) w.resolve(byId[id] ?? null);
      },
      (error) => {
        for (const id of ids) for (const w of waiting.get(id) ?? []) w.reject(error);
      }
    );
  }
}

/** One model's sale, coalesced with every other card asking within the window. `null` = no sale. */
function loadModelSale(modelId: number): Promise<ModelSale | null> {
  return new Promise((resolve, reject) => {
    const waiters = pendingSales.get(modelId);
    if (waiters) waiters.push({ resolve, reject });
    else pendingSales.set(modelId, [{ resolve, reject }]);
    if (!saleFlushScheduled) {
      saleFlushScheduled = true;
      modelSaleBatcher.schedule(flushSales);
    }
  });
}

/** Test helper: clear the module-level batcher between tests. */
export function __resetModelSaleBatcher() {
  pendingSales.clear();
  saleFlushScheduled = false;
}

/**
 * One model's sale as its OWN request for exactly `{ ids: [modelId] }` — the input the per-card hook
 * has always sent, through the same client links, so the request URL is unchanged.
 */
function loadModelSaleAlone(modelId: number): Promise<ModelSale | null> {
  return modelSaleBatcher
    .fetch([modelId])
    .then((sales) => ((sales ?? {}) as SalesByModelId)[modelId] ?? null);
}

/**
 * The sale for ONE model, for a card rendered outside any provider — home blocks, collections, related
 * models, search results.
 *
 * Each card owns a query keyed per model (so two cards for one model share it). How it resolves
 * depends on whether the browser is signed in:
 *
 * - SIGNED IN: through `loadModelSale`, which coalesces every card that asks within
 *   `MODEL_SALE_BATCH_WINDOW_MS` into ONE `getActiveSales` call. A signed-in response is never
 *   shared-cached, so every one of those lookups reached the server anyway; merging them only removes
 *   work.
 * - ANONYMOUS: one request per card for `{ ids: [modelId] }`, deliberately NOT batched. An anonymous
 *   GET response is shared-cacheable and the cache is keyed by the exact URL, so the single-id URL of
 *   a popular model is answered from cache for everyone who sees it. A merged URL lists whichever ids
 *   happened to share a surface, which almost never repeats, so batching anonymous cards would turn
 *   those cache hits into server requests.
 *
 * The predicate is `isAuthedBrowser` (`window.isAuthed`, set from the session user) — the same one
 * the tRPC links route and tag requests on, and the same fact (a session user) the server keys its
 * cache headers on. It is read when the query RUNS, not at render, so it sees the value the links will.
 * Before the session resolves it reads false, the safe direction: an unbatched request.
 *
 * A container that can supply the map should still pass `salesByModelId` and skip this entirely —
 * that is why the skip flag is "a provider owns this", not "the provider's data has arrived".
 */
export const useModelSaleBadge = (modelId: number, skip: boolean) => {
  const { data } = useQuery({
    queryKey: ['model.getActiveSales.byModel', modelId],
    queryFn: () => (isAuthedBrowser() ? loadModelSale(modelId) : loadModelSaleAlone(modelId)),
    enabled: !skip,
    staleTime: 60_000,
  });
  // Same end-edge re-check as the batched hook — a card outside a provider caches its answer for
  // `staleTime` too, so the badge must not outlive the window it is advertising.
  return data && stillRunning(data, Date.now()) ? data : undefined;
};

/**
 * The sales for a whole surface of cards.
 *
 * 🔴 CHUNKED, because the procedure caps `ids` at `MODEL_SALE_IDS_PER_QUERY` and an infinite feed
 * does not stop growing. Asking for the accumulated list in one call worked until the fifth page
 * of ~100 cards, and from there EVERY call 400d — so the badge silently vanished from the whole
 * grid for anyone who scrolled, on a money surface, invisibly to anything watching 5xx.
 *
 * Chunking is the fix rather than a bigger cap: the resolver's work is per-id — one Redis GET each
 * — so the cap is what keeps a single request's fan-out proportional to a page of cards rather than
 * to the whole accumulated feed. The chunk is deliberately SMALLER than the cap and matched to the
 * feed's page size; `~/server/schema/model-sale.schema` has the arithmetic for why, and it is not
 * "as big as allowed".
 *
 * The shared chunker, not a copy of it — its own tests pin the property this depends on and
 * does not spell out in code: chunking in ARRIVAL order keeps an earlier chunk's key stable as the
 * feed appends, where sorting would reshuffle every boundary and refetch the whole surface on each
 * page. Growing by a page therefore costs ONE new request, not one per chunk.
 */
export const useModelSaleBadges = (modelIds: number[]) => {
  const chunks = useMemo(
    () => chunkIds(modelIds, MODEL_SALE_IDS_PER_REQUEST),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelIds.join(',')]
  );

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) => t.model.getActiveSales({ ids: chunk }, { staleTime: 60_000 }))
  );

  const merged = useMemo(() => {
    // A partly-loaded surface merges what it has, so badges appear per chunk instead of the whole
    // grid waiting on the slowest one. `undefined` — not `{}` — while nothing has arrived, so a
    // consumer reads "no sale yet" rather than "no sale". Unfiltered on purpose: the end edge is
    // applied on the way OUT, below.
    const loaded = queries.map((query) => query.data).filter((data) => !!data);
    if (!loaded.length) return undefined;
    return Object.assign({}, ...loaded) as SalesByModelId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((query) => query.dataUpdatedAt).join(',')]);

  // 🔴 KEEP-PREVIOUS BY HAND, because `placeholderData` DOES NOT WORK UNDER `useQueries`. Measured
  // against the installed @tanstack/query-core: `QueriesObserver` matches previous observers by
  // `queryHash` only, so a key change builds a FRESH `QueryObserver` whose
  // `#lastQueryWithDefinedData` is empty and `placeholderData: (prev) => prev` resolves to
  // `undefined`. `useQuery` keeps one observer for the component's life and does carry it across —
  // which is why the option worked before this hook fanned out, and silently stopped when it did.
  // Without this the whole grid's badges blank for the round trip on every page of scroll.
  const lastLoaded = useRef<SalesByModelId | undefined>(undefined);
  if (merged) lastLoaded.current = merged;
  const known = merged ?? lastLoaded.current;

  // 🔴 ONE GATE, ON THE MAP BEING HANDED OUT — not on the merge. Filtering inside the merge stamped
  // the answer at the moment the DATA arrived, so the kept-previous map escaped unchecked and could
  // resurrect a window that had closed since it was stored.
  //
  // The clock is re-read on every event that changes WHICH map is being served: a chunk arriving
  // (`known` identity moves) and falling back or recovering (`heldOver` flips) — the latter is the
  // load-bearing one, because the fallback hands out the SAME object and an identity-keyed memo
  // therefore would not re-check it. In between, the returned object stays referentially stable; a
  // fresh object every render would churn the context and re-render every memoised card.
  //
  // ⚠️ RESIDUAL, and it is the STEADY STATE on any surface that has stopped growing — not an edge
  // case, which is how an earlier wording of this comment ("left mounted and IDLE") read.
  // `refetchOnWindowFocus` is false APP-WIDE (`~/utils/trpc`'s queryClientConfig), the only
  // per-query override here is `staleTime`, and a stale query does not refetch by itself. So the
  // memo below re-reads the clock ONLY when a chunk resolves, the connection recovers, or the hook
  // remounts. On a surface that has stopped growing — `OnSaleSection`'s single chunk, a search page
  // the user stopped paging, a feed scrolled to the end — none of those fire, and returning to the
  // tab does not force one: the gate freezes for the life of the mount. Concretely, a profile page
  // opened at T keeps advertising at T+2h a sale that ended at T+20m.
  //
  // This is not a regression — before this hook chunked, the map was never end-checked at all — and
  // closing it needs the gate at the per-card read in `ModelCard`, where it costs one comparison
  // per card, not a re-filter of the whole map. Deliberately NOT closed with a timer here: a
  // `refetchInterval` would re-issue the per-id Redis fan-out this endpoint is capped to bound, for
  // every mounted feed of every user, to fix a display edge.
  const heldOver = !merged;
  return useMemo(
    () => (known ? runningSalesOnly(known, Date.now()) : undefined),
    // `heldOver` is not read inside, so eslint calls it unnecessary — it is the point. The clock is
    // an implicit input this memo has no other way to depend on, and this flag is the event that
    // means "the same object is now being served for a different reason, re-read it".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [known, heldOver]
  );
};

export const ModelCardContextProvider = ({
  children,
  useModelVersionRedirect,
  activeBaseModels,
  salesByModelId,
  hasSaleProvider,
}: Context & { children: ReactNode }) => {
  const value = useMemo(
    () => ({ useModelVersionRedirect, activeBaseModels, salesByModelId, hasSaleProvider }),
    [useModelVersionRedirect, activeBaseModels, salesByModelId, hasSaleProvider]
  );
  return <ModelCardContext.Provider value={value}>{children}</ModelCardContext.Provider>;
};
