import type { SaleDiscountKind } from '@civitai/buzz';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useRef } from 'react';
import { MODEL_SALE_IDS_PER_REQUEST } from '~/server/schema/model-sale.schema';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

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
 * The sale for ONE model, for a card rendered outside any provider — home blocks, collections, related
 * models, search results.
 *
 * ⚠️ This is one request PER CARD. tRPC only batches for an authenticated browser (see shouldBatch in
 * utils/trpc.ts), so an anonymous grid issues one XHR each, and even when batched the URL cap fits about
 * 24 ops. A container that can supply the map should pass `salesByModelId` and skip this entirely —
 * that is why the skip flag is "a provider owns this", not "the provider's data has arrived".
 */
export const useModelSaleBadge = (modelId: number, skip: boolean) => {
  const { data } = trpc.model.getActiveSales.useQuery(
    { ids: [modelId] },
    { enabled: !skip, staleTime: 60_000 }
  );
  const sale = data?.[modelId];
  // Same end-edge re-check as the batched hook — a card outside a provider caches its answer for
  // `staleTime` too, so the badge must not outlive the window it is advertising.
  return sale && stillRunning(sale, Date.now()) ? sale : undefined;
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
 * — on a PUBLIC procedure, so the cap is the only bound on it. The chunk is deliberately SMALLER
 * than the cap and matched to the feed's page size; `~/server/schema/model-sale.schema` has the
 * arithmetic for why, and it is not "as big as allowed".
 *
 * The shared chunker, not a third copy of it — its own tests pin the property this depends on and
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
  // ⚠️ RESIDUAL, and it is pre-existing rather than introduced here: a feed left mounted and IDLE
  // re-reads nothing, so a window closing with no scroll and no refetch stays badged. That was
  // equally true before this hook chunked — the map was never re-checked at all — and closing it
  // needs the gate at the per-card read in `ModelCard`, not here.
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
