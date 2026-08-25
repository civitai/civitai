import { z } from 'zod';
import type { Cookies } from '@sveltejs/kit';
import {
  getCreatorModels,
  MODELS_PER_PAGE,
  PAGE_SIZE_OPTIONS,
  PAGE_SIZE_COOKIE,
  type CreatorModelsResult,
} from '$lib/server/models';
import { getSalesByVersion } from '$lib/server/monetization/sales';
import { getFlipt, fliptContext } from '$lib/server/flipt';

// Lives here rather than beside the page because SvelteKit only permits its own named exports from a
// `+page.server.ts` — `getModelsView` there 500s the route on load.
const modelsQuerySchema = z.object({
  q: z.string().optional(),
  fee: z.enum(['set', 'off']).optional().catch(undefined),
  bm: z.string().optional(),
  mt: z.string().optional(),
  status: z.enum(['all', 'published', 'draft']).optional().catch(undefined),
  access: z.enum(['1']).optional().catch(undefined),
  usage: z.enum(['download', 'generation']).optional().catch(undefined),
  // Set by "New sale", which sends the creator here to pick what the sale covers.
  for: z.enum(['sale']).optional().catch(undefined),
  sort: z.enum(['recent', 'name']).catch('recent'),
  page: z.coerce.number().int().min(1).catch(1),
  // Page-size selector value (868ke493p); persisted to a cookie so it applies on later loads.
  ps: z.coerce.number().int().optional().catch(undefined),
});

// A year — the page-size preference should stick.
const PAGE_SIZE_MAX_AGE = 60 * 60 * 24 * 365;
function resolvePageSize(psParam: number | undefined, cookieVal: string | undefined): number {
  const opts = PAGE_SIZE_OPTIONS as readonly number[];
  if (psParam && opts.includes(psParam)) return psParam;
  const c = Number(cookieVal);
  return opts.includes(c) ? c : MODELS_PER_PAGE;
}

/** What a query change replaces. The page swaps this wholesale; everything else in `data` survives. */
export type ModelsView = CreatorModelsResult & {
  perPage: number;
  salesEnabled: boolean;
  salesByVersion: Awaited<ReturnType<typeof getSalesByVersion>>;
  query: {
    q: string;
    fee: string;
    bm: string;
    mt: string;
    status: string;
    access: boolean;
    usage: string;
    sort: 'recent' | 'name';
    /** Picking versions for a sale: the list is narrowed to what a sale could discount. */
    saleOnly: boolean;
  };
};

/**
 * The slice of /models a search, filter, sort or page change replaces — and nothing else.
 *
 * Shared by the page load and `models/search/+server.ts` so filter-as-you-type re-runs exactly this.
 * The caps, scores and `canSetGenerationOnlyFresh` call beside it in the load are per-creator, not
 * per-query: no term the creator types can change them, so a debounced keystroke must not pay for
 * them (CU 868kv6ejd).
 */
export async function getModelsView(
  user: App.Locals['user'],
  url: URL,
  cookies: Cookies
): Promise<ModelsView> {
  const parsed = modelsQuerySchema.parse(Object.fromEntries(url.searchParams));
  const q = parsed.q?.trim() || undefined;
  const baseModel = parsed.bm?.trim() || undefined;
  const type = parsed.mt?.trim() || undefined;
  const access = parsed.access === '1';
  // The list a sale is picked from must only offer versions a sale can actually discount — a version
  // with no permanent paid-access price takes the sale and shows nothing anywhere (CU 868kwp6mp).
  //
  // Gated on the flag, which costs a serial await before the models query: the page keys its whole
  // sale-preparation mode off `saleOnly`, so leaving it flag-independent meant a creator without the
  // feature could land on `?for=sale` from a link, get the banner and a narrowed list, and be walked to
  // a Continue button into a page that tells them the feature is off. `isEnabled` memoises, so the cost
  // is a cached read, not a round trip per load.
  const salesEnabled = await getFlipt().isEnabled(
    'scheduled-model-sales',
    String(user.id),
    fliptContext(user)
  );
  const saleOnly = parsed.for === 'sale' && salesEnabled;

  // Page size: an explicit ?ps= updates the shared cookie; otherwise fall back to the cookie, then the default.
  const perPage = resolvePageSize(parsed.ps, cookies.get(PAGE_SIZE_COOKIE));
  if (parsed.ps && (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed.ps)) {
    cookies.set(PAGE_SIZE_COOKIE, String(perPage), { path: '/', maxAge: PAGE_SIZE_MAX_AGE });
  }

  const result = await getCreatorModels({
    userId: user.id,
    q,
    fee: parsed.fee,
    baseModel,
    type,
    status: parsed.status,
    access,
    usage: parsed.usage,
    saleEligible: saleOnly,
    sort: parsed.sort,
    page: parsed.page,
    perPage,
    // Selection is always available, so "select all matching filters" always needs the full id set.
    withMatchingVersionIds: true,
  });

  // Sales are read ONLY when the feature is on. Migrations here are applied by hand, so on any
  // environment where the sale tables have not been created yet an unconditional read makes /models
  // throw for every creator — flag on or off. The flag has to gate the reads, not just the UI.
  const salesByVersion = salesEnabled
    ? await getSalesByVersion(
        user.id,
        result.models.flatMap((m) => m.versions.map((v) => v.id))
      )
    : {};

  return {
    ...result,
    perPage,
    salesEnabled,
    salesByVersion,
    query: {
      q: q ?? '',
      fee: parsed.fee ?? '',
      bm: baseModel ?? '',
      mt: type ?? '',
      status: parsed.status ?? '',
      access,
      usage: parsed.usage ?? '',
      sort: parsed.sort,
      saleOnly,
    },
  };
}
