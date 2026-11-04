import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { openItem, type ItemRef } from '$lib/server/feed-token';
import { getPlayerStatus } from '$lib/server/player-status';
import { voteLockUntil } from '$lib/server/queue/vote-rate';
import { queueDeps } from '$lib/server/queue/runtime';
import { feedSecret } from '$lib/server/smites/runtime';
import { skipStore } from '$lib/server/skip-runtime';
import { skippedFor } from '$lib/server/skips';
import { getStanding } from '$lib/server/standing';
import { MAX_EXCLUDED } from '../optimistic';
import { pickItem } from '../next-item.server';
import type { RequestHandler } from './$types';

const NOTHING = () => json({ next: null }, { headers: { 'cache-control': 'no-store' } });

/**
 * The item after the ones named in `after`, which the player has not finished voting on: what the page shows the moment
 * a vote is sent, while the vote itself posts in the background. Served only when the real feed would serve an item (not
 * muted, not paced, no reset pending); otherwise the page waits for the vote like any other. It reads and records nothing.
 * The roll for hidden checks and yes/no questions comes from the named items, so asking again changes nothing.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const userId = locals.user.id;
  const [status, { muted }] = await Promise.all([
    getPlayerStatus(db, userId),
    getStanding(db, userId),
  ]);
  if (!status || muted || status.rank === 'Acolyte' || status.smites >= status.maxSmites)
    return NOTHING();

  const now = queueDeps.now();
  if (queueDeps.voteLimits && !locals.user.isModerator) {
    if (await voteLockUntil(db, userId, now, queueDeps.voteLimits)) return NOTHING();
  }

  const secret = feedSecret();
  const named = url.searchParams
    .getAll('after')
    .slice(-MAX_EXCLUDED)
    .map((token) => openItem(secret, userId, token))
    .filter((ref): ref is ItemRef => ref !== null);
  const skipped = await skippedFor(skipStore, userId);
  for (const ref of named) skipped[ref.kind].push(ref.id);

  const digest = createHash('sha256')
    .update(`${secret}:next:${userId}:${named.map((ref) => `${ref.kind}${ref.id}`).join(',')}`)
    .digest();
  const next = await pickItem(userId, status.rank, skipped, digest.readUInt32BE(0));
  return json({ next }, { headers: { 'cache-control': 'no-store' } });
};
