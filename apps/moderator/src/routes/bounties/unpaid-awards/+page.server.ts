import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { BOUNTY_AWARD_RULINGS } from '@civitai/shared/bounty-award';
import type { Actions, PageServerLoad } from './$types';
import {
  RESOLVED_WINDOW_DAYS,
  getUnpaidAwards,
  unpaidAwardTableExists,
} from '$lib/server/bounty-unpaid-award.service';
import { callModEndpoint } from '$lib/server/user-actions.service';
import { parseForm } from '$lib/server/query';

const LIMIT = 100;

export const load: PageServerLoad = async ({ url }) => {
  const resolved = url.searchParams.get('tab') === 'resolved';
  const migrated = await unpaidAwardTableExists();
  const { items, hasMore } = migrated
    ? await getUnpaidAwards({ resolved, limit: LIMIT })
    : { items: [], hasMore: false };
  return {
    tab: resolved ? 'resolved' : 'open',
    migrated,
    items,
    hasMore,
    limit: LIMIT,
    RESOLVED_WINDOW_DAYS,
  };
};

export const actions = {
  resolve: async ({ request }) => {
    const input = parseForm(
      z.object({
        bountyId: z.coerce.number().int().positive({ error: 'Missing bounty id.' }),
        userId: z.coerce.number().int().positive({ error: 'Missing supporter id.' }),
        ruling: z.enum(BOUNTY_AWARD_RULINGS, { error: 'Pick a ruling.' }),
        ledgerReference: z
          .string({ error: 'A ledger reference is required.' })
          .trim()
          .min(1, { error: 'A ledger reference is required.' })
          .max(500, { error: 'The ledger reference is too long.' }),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    // The main app owns the lock, the legacy backfill and the audit; this records a ruling and
    // moves no Buzz.
    const result = await callModEndpoint('bounty-unpaid-award/resolve', input, 'Record ruling');
    if (!result.ok)
      return fail(400, { error: result.error, bountyId: input.bountyId, userId: input.userId });
    return { success: true };
  },
} satisfies Actions;
