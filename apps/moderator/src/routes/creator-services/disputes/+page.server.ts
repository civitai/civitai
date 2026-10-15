import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import {
  type DealFile,
  type DisputeResolution,
  type DisputeRow,
  listDealFiles,
  listDisputes,
  resolveDispute,
} from '$lib/server/creator-services-disputes.service';
import { int4Id } from '$lib/server/query';

const LIMIT = 25;

export type DisputeCardRow = DisputeRow & { files: DealFile[] | null; filesError: string | null };

const querySchema = z.object({ cursor: z.string().min(1).max(64).optional().catch(undefined) });

export const load: PageServerLoad = async ({ url }) => {
  const { cursor } = querySchema.parse(Object.fromEntries(url.searchParams));
  const result = await listDisputes(cursor, LIMIT);
  // Rendered, not thrown: a refused read is shown inline instead of replacing the page.
  if (!result.ok)
    return {
      items: [] as DisputeCardRow[],
      nextCursor: undefined,
      cursor: cursor ?? null,
      error: result.error,
    };

  // One call per page; a failure marks every card rather than hiding the queue.
  const files = await listDealFiles(result.page.items.map((row) => row.id));
  const withFiles = result.page.items.map((row) => ({
    ...row,
    files: files.ok ? files.files.filter((file) => file.dealId === row.id) : null,
    filesError: files.ok ? null : files.error,
  }));
  return {
    items: withFiles,
    nextCursor: result.page.nextCursor,
    cursor: cursor ?? null,
    error: null,
  };
};

const resolveSchema = z.object({
  dealId: int4Id,
  resolution: z.enum(['Refund', 'Release']),
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || undefined),
});

export type ResolveOutcome = {
  success?: true;
  dealId: number;
  alreadyResolved?: boolean;
  resolution?: DisputeResolution;
  heldForReview?: string;
  error?: string;
  releaseRefused?: boolean;
};

export const actions: Actions = {
  resolve: requiresGrant('creatorServices.resolveDispute', async ({ request }) => {
    const parsed = resolveSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: 'Invalid resolution.' });
    const { dealId } = parsed.data;

    const result = await resolveDispute(parsed.data);
    if (result.ok && result.status === 'held-for-review')
      return {
        success: true as const,
        dealId,
        heldForReview: result.reason ?? 'no reason recorded',
      };
    if (result.ok)
      return {
        success: true as const,
        dealId,
        alreadyResolved: result.status === 'already-resolved',
        resolution: result.resolution,
      };
    if (result.refused) return fail(409, { error: result.message, dealId, releaseRefused: true });
    return fail(502, { error: result.error, dealId });
  }),
};
