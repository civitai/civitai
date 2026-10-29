import { fail } from '@sveltejs/kit';
import { getGoldBalance } from '$lib/server/conversion/balance';
import { convertGold, type ConvertResult } from '$lib/server/conversion/convert';
import { buzzConfigured, getBuzzPort } from '$lib/server/conversion/runtime';
import { logToAxiom } from '$lib/server/axiom';
import { db } from '$lib/server/db';
import { getPlayerStatusOrNew } from '$lib/server/player-status';
import type { Actions, PageServerLoad } from './$types';

const REFUSAL_TEXT = {
  'no-player': 'You have not joined the Order yet.',
  held: 'Your gold is frozen while your account is under review.',
  'below-minimum': 'You do not have enough convertible gold yet.',
} as const;

export const load: PageServerLoad = async ({ locals }) => {
  const [status, balance] = await Promise.all([
    getPlayerStatusOrNew(db, locals.user.id),
    getGoldBalance(db, locals.user.id),
  ]);
  return { status, balance };
};

let warnedNoEndpoint = false;

export const actions: Actions = {
  convert: async ({ locals }) => {
    if (!buzzConfigured()) {
      if (!warnedNoEndpoint) {
        warnedNoEndpoint = true;
        await logToAxiom({
          type: 'warning',
          name: 'knights-conversion-unavailable',
          message: 'BUZZ_ENDPOINT is not configured; gold cannot be converted',
        });
      }
      return fail(503, {
        message: 'Converting gold is not available right now. Your gold is untouched.',
      });
    }
    let result: ConvertResult;
    try {
      result = await convertGold(db, getBuzzPort(), {
        playerId: locals.user.id,
        now: new Date(),
        log: logToAxiom,
      });
    } catch (error) {
      console.error('knights: gold conversion failed', { error });
      return fail(500, { message: 'Your gold could not be converted. Try again in a moment.' });
    }
    if (result.status === 'refused') return fail(409, { message: REFUSAL_TEXT[result.reason] });
    if (result.status === 'failed') {
      return fail(502, {
        message: result.forfeited
          ? 'Buzz refused this conversion, which was made before your career reset, so its gold is forfeited with the rest.'
          : 'Buzz could not take this conversion. Your gold is untouched; try again later.',
      });
    }
    if (result.status === 'pending') {
      return {
        ok: true,
        pending: true,
        message: `Your ${result.buzz} Buzz is on its way. It is paid within a few minutes, and the gold is not spent twice.`,
      };
    }
    return {
      ok: true,
      converted: result.buzz,
      message: `Converted ${result.gold.toLocaleString('en-US')} gold into ${result.buzz} Buzz.`,
    };
  },
};
