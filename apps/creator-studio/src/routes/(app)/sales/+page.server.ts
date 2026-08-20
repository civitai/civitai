import { z } from 'zod';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { resolveMembership, cappedTier, TEST_MEMBERSHIP_COOKIE } from '$lib/server/membership';
import { bustVersionCache } from '$lib/server/monetization/bust-cache';
import { getSaleLimitOverrides } from '$lib/server/monetization/sale-limits';
import {
  cancelSale,
  cheapestCoveredPrice,
  countEarlyAccessVersions,
  deepenSale,
  getCreatorSales,
  getManageableSales,
  scheduleSale,
  shortenSale,
  versionIdsForSale,
} from '$lib/server/monetization/sales';
import { resolveCreatorScore, TEST_CREATOR_SCORE_COOKIE } from '$lib/server/creator-score';
import { minCreatorScoreForSale } from '@civitai/buzz';
import { getFlipt } from '$lib/server/flipt';

// Managing scheduled sales. Starting one lives on the models page, where the selection is — this page is
// where they are listed and changed, and clicking one opens a side panel (the same interaction the models
// list uses for a version).

const saleIdSchema = z.coerce.number().int().positive();

// Only the directions a running sale may move: earlier end, deeper discount. Each refusal is enforced in
// the UPDATE's own WHERE clause, so these schemas shape input rather than decide policy.
const shortenSaleSchema = z.object({ saleId: saleIdSchema, lastDay: z.coerce.date() });
const deepenSaleSchema = z.object({
  saleId: saleIdSchema,
  discountAmount: z.coerce.number().int().positive(),
});

// Scheduling a sale. Dates arrive as ISO instants the form already resolved to UTC midnight, so nothing
// here has to guess a timezone. The window rules (lead time, budget, zero-floor) are enforced in
// scheduleSale against the primary — this only shapes the input.
const scheduleSaleSchema = z.object({
  name: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((v) => (v ? v : undefined)),
  discountType: z.enum(['Fixed', 'Percent']),
  discountAmount: z.coerce.number().int().positive(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

// The selection arrives as a comma-joined id list ("1,2,3"), carried in the URL from the models page.
const versionIdsSchema = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  )
  .refine((ids) => ids.length > 0, 'Select at least one version.');

const firstError = (e: z.ZodError) => e.issues[0]?.message ?? 'Invalid input.';

// Gates every action, not just the reads: with the flag off as a kill switch, editing an existing sale has
// to stop too, or the switch only stops new ones.
const salesOff = async (userId: number) =>
  !(await getFlipt().isEnabled('scheduled-model-sales', String(userId)));

export const load: PageServerLoad = async ({ locals, parent, cookies }) => {
  const { membership } = await parent();
  const salesEnabled = await getFlipt().isEnabled('scheduled-model-sales', String(locals.user.id));

  // Read only when the feature is on: migrations here are applied by hand, so an unconditional read
  // throws for every creator on an environment where the tables do not exist yet.
  const [sales, manageableSales, saleLimits, creatorScore] = salesEnabled
    ? await Promise.all([
        getCreatorSales(locals.user.id),
        getManageableSales(locals.user.id),
        getSaleLimitOverrides(),
        resolveCreatorScore(
          locals.user.id,
          !!locals.user.isModerator,
          cookies.get(TEST_CREATOR_SCORE_COOKIE)
        ),
      ])
    : [[], [], {}, 0];

  return {
    salesEnabled,
    sales,
    manageableSales,
    saleLimits,
    creatorScore,
    capTier: cappedTier(membership),
  };
};

export const actions: Actions = {
  // What the sale form needs about a selection it can't see: how much of it is early access (a sale
  // can't cover that) and the cheapest price among the rest (a fixed discount must stay under it).
  salePreview: async ({ request, locals, cookies }) => {
    if (await salesOff(locals.user.id))
      return fail(403, { error: 'Scheduled sales are not available yet.' });
    const form = await request.formData();
    const parsed = versionIdsSchema.safeParse(form.get('versionIds'));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });
    const [earlyAccess, minCoveredPrice] = await Promise.all([
      countEarlyAccessVersions(locals.user.id, parsed.data),
      cheapestCoveredPrice(
        locals.user.id,
        parsed.data,
        cappedTier(resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE)))
      ),
    ]);
    return { earlyAccess, minCoveredPrice };
  },

  scheduleSale: async ({ request, locals, cookies }) => {
    if (await salesOff(locals.user.id))
      return fail(403, { error: 'Scheduled sales are not available yet.' });

    const form = await request.formData();
    const ids = versionIdsSchema.safeParse(form.get('versionIds'));
    if (!ids.success) return fail(400, { error: firstError(ids.error) });
    // Object.fromEntries, never a hand-listed literal: a field added to the schema later would never
    // reach it, and every refine guarding that field would pass vacuously.
    const parsed = scheduleSaleSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });

    // The score floor is a server rule, not a form hint — the form only renders the progress bar.
    const creatorScore = await resolveCreatorScore(
      locals.user.id,
      !!locals.user.isModerator,
      cookies.get(TEST_CREATOR_SCORE_COOKIE)
    );
    const saleLimits = await getSaleLimitOverrides();
    const minScore = minCreatorScoreForSale(saleLimits);
    if (creatorScore < minScore)
      return fail(403, {
        error: `Sales unlock at a creator score of ${minScore.toLocaleString()}.`,
      });

    // cappedTier, not the display label: a lapsed membership keeps its name but is capped at free.
    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await scheduleSale(
      locals.user.id,
      ids.data,
      cappedTier(membership),
      {
        name: parsed.data.name,
        discountType: parsed.data.discountType,
        discountAmount: parsed.data.discountAmount,
        startsAt: parsed.data.startsAt,
        endsAt: parsed.data.endsAt,
      },
      saleLimits
    );
    if (!result.ok) return fail(400, { error: result.error });

    await bustVersionCache(
      request.headers.get('cookie') ?? '',
      await versionIdsForSale(result.saleId)
    );

    return {
      scheduled: true,
      covered: result.covered,
      skippedEarlyAccess: result.skippedEarlyAccess,
    };
  },

  cancelSale: async ({ request, locals }) => {
    if (await salesOff(locals.user.id))
      return fail(403, { error: 'Scheduled sales are not available yet.' });
    const form = await request.formData();
    const parsed = saleIdSchema.safeParse(form.get('saleId'));
    if (!parsed.success) return fail(400, { error: 'Invalid sale.' });

    const result = await cancelSale(locals.user.id, parsed.data);
    if (!result.ok) return fail(400, { error: result.error });
    await bustVersionCache(request.headers.get('cookie') ?? '', result.versionIds);
    return { cancelled: true };
  },

  shortenSale: async ({ request, locals }) => {
    if (await salesOff(locals.user.id))
      return fail(403, { error: 'Scheduled sales are not available yet.' });
    const form = await request.formData();
    const parsed = shortenSaleSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });

    // The picked day is the sale's new LAST day, inclusive — the same reading the scheduling form uses,
    // and what the list renders back. Posting it through as the exclusive boundary would end the sale a
    // day earlier than the creator picked.
    const endsAt = new Date(parsed.data.lastDay.getTime() + 86_400_000);
    const result = await shortenSale(locals.user.id, parsed.data.saleId, endsAt);
    if (!result.ok) return fail(400, { error: result.error });
    await bustVersionCache(request.headers.get('cookie') ?? '', result.versionIds);
    return { shortened: true };
  },

  deepenSale: async ({ request, locals, cookies }) => {
    if (await salesOff(locals.user.id))
      return fail(403, { error: 'Scheduled sales are not available yet.' });
    const form = await request.formData();
    const parsed = deepenSaleSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });

    // cappedTier, never the display tier: the zero-floor is measured against what a buyer is charged,
    // and a lapsed membership is capped at free however its label reads.
    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await deepenSale(
      locals.user.id,
      parsed.data.saleId,
      parsed.data.discountAmount,
      cappedTier(membership)
    );
    if (!result.ok) return fail(400, { error: result.error });
    await bustVersionCache(request.headers.get('cookie') ?? '', result.versionIds);
    return { deepened: true };
  },
};
