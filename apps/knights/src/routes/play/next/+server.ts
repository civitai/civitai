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
import { BUFFER_TARGET, MAX_EXCLUDED, type PickedItem } from '../optimistic';
import { pickItem } from '../next-item.server';
import type { RequestHandler } from './$types';

const reply = (items: PickedItem[]) =>
  json({ next: items[0] ?? null, items }, { headers: { 'cache-control': 'no-store' } });
const NOTHING = () => reply([]);

/**
 * The item after the ones named in `after`, which the player has not finished voting on: what the page shows the moment
 * a vote is sent, while the vote itself posts in the background. Served only when the real feed would serve an item (not
 * muted, not paced, no reset pending); otherwise the page waits for the vote like any other. It reads and records nothing.
 * `count` asks for up to BUFFER_TARGET items in order, each picked as if the ones before it were already judged. The
 * roll for hidden checks and yes/no questions comes from the named items (and the ones picked before it), so asking
 * again changes nothing and no two positions share a roll.
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

  const wanted = Number.parseInt(url.searchParams.get('count') ?? '1', 10);
  const count = Math.min(Math.max(Number.isFinite(wanted) ? wanted : 1, 1), BUFFER_TARGET);

  const items: PickedItem[] = [];
  const taken = [...named];
  while (items.length < count) {
    const digest = createHash('sha256')
      .update(`${secret}:next:${userId}:${taken.map((ref) => `${ref.kind}${ref.id}`).join(',')}`)
      .digest();
    const leaveOut = {
      queue: [...skipped.queue],
      hidden: [...skipped.hidden],
      yesno: [...skipped.yesno],
    };
    for (const ref of taken) leaveOut[ref.kind].push(ref.id);
    const next = await pickItem(userId, status.rank, leaveOut, digest.readUInt32BE(0));
    const ref = next && openItem(secret, userId, next.item.id);
    if (!next || !ref || taken.some((t) => t.kind === ref.kind && t.id === ref.id)) break;
    items.push(next);
    taken.push(ref);
  }
  return reply(items);
};
