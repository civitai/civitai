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

  // Page size: an explicit ?ps= updates the shared cookie; otherwise fall back to the cookie, then the default.
  const perPage = resolvePageSize(parsed.ps, cookies.get(PAGE_SIZE_COOKIE));
  if (parsed.ps && (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed.ps)) {
    cookies.set(PAGE_SIZE_COOKIE, String(perPage), { path: '/', maxAge: PAGE_SIZE_MAX_AGE });
  }

  const [result, salesEnabled] = await Promise.all([
    getCreatorModels({
      userId: user.id,
      q,
      fee: parsed.fee,
      baseModel,
      type,
      status: parsed.status,
      access,
      usage: parsed.usage,
      sort: parsed.sort,
      page: parsed.page,
      perPage,
      // Selection is always available, so "select all matching filters" always needs the full id set.
      withMatchingVersionIds: true,
    }),
    // Per-user entityId so the feature can open to a few creators before everyone. `isEnabled` rather
    // than `getBoolean`: only the former honours FLIPT_LOCAL_OVERRIDES, so this is togglable locally.
    getFlipt().isEnabled('scheduled-model-sales', String(user.id), fliptContext(user)),
  ]);

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
    },
  };
}
