import { dbRead } from '~/server/db/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import {
  SERVICES_MIN_CREATOR_SCORE,
  SERVICES_MIN_CREATOR_SCORE_KEY,
} from '~/shared/constants/creator-service.constants';

const OVERRIDE_TTL_MS = 60 * 1000;

/** A positive whole number, or null: a bad row must never open selling to every score. */
function parseMinScore(value: unknown) {
  const score = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof score === 'number' && Number.isSafeInteger(score) && score > 0 ? score : null;
}

const override = createTtlMemo(async () => {
  const row = await dbRead.keyValue.findUnique({ where: { key: SERVICES_MIN_CREATOR_SCORE_KEY } });
  return parseMinScore(row?.value);
}, OVERRIDE_TTL_MS);

/** The Creator Score selling services needs: the `KeyValue` override, else the compiled minimum. */
export async function getServicesMinCreatorScore() {
  try {
    return (await override()) ?? SERVICES_MIN_CREATOR_SCORE;
  } catch {
    return SERVICES_MIN_CREATOR_SCORE;
  }
}

export const clearServicesMinCreatorScoreCache = () => override.clear();
