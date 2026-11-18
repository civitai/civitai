import { imageUrl } from '$lib/server/image-url';
import { sealItem, type ItemRef } from '$lib/server/feed-token';
import { pickHiddenCheck } from '$lib/server/hidden/hidden.service';
import { hiddenSettings } from '$lib/server/hidden/runtime';
import { getFeed } from '$lib/server/queue/queue.service';
import { feedSecret } from '$lib/server/smites/runtime';
import type { Skipped } from '$lib/server/skips';
import { burstDue, burstRoller, servedHistory } from '$lib/server/yesno/cadence';
import { pickYesNo } from '$lib/server/yesno/feed';
import { YESNO_ANSWERS } from '$lib/server/yesno/keys';
import { yesNoConfig } from '$lib/server/yesno/runtime';
import { db } from '$lib/server/db';
import { itemKey, type PickedItem } from './optimistic';

/**
 * The next thing to judge: a yes/no question when the burst cadence (`yesno/cadence.ts`) says one is due, or when there is no
 * rating to show; otherwise a hidden check if one is rolled (it only rides on a rating slot), then the queue. `slot` rolls the
 * hidden check for an item the player has not reached yet; unset, the roll is fixed by their last vote.
 */
export async function pickItem(
  userId: number,
  rank: string,
  skipped: Skipped | null,
  slot?: number,
  /** Yes/no question ids already handed out ahead of the player, oldest first: the stretch counts them. */
  ahead?: number[],
  /** Every item already handed out ahead of the player, oldest first: the cadence counts them as served. */
  served?: ItemRef[]
): Promise<PickedItem | null> {
  const feed = await getFeed(db, userId, { limit: 1, exclude: skipped?.queue });
  const secret = feedSecret();

  const yesNo = await yesNoConfig();
  const due =
    yesNo.share > 0 &&
    (!feed || burstDue(await servedHistory(db, userId, served), burstRoller(secret, userId)));
  const offer = due
    ? await pickYesNo(db, {
        userId,
        rank,
        secret,
        share: yesNo.share,
        stretch: yesNo.stretch,
        force: true,
        exclude: skipped?.yesno,
        ahead,
        slot,
      })
    : null;
  if (offer) {
    return {
      banner: offer.banner,
      category: offer.category,
      question: {
        key: 'yesno',
        kind: 'bool',
        prompt: offer.prompt,
        options: YESNO_ANSWERS.map((answer) => ({ ...answer })),
      },
      item: {
        id: sealItem(secret, userId, { kind: 'yesno', id: offer.itemId }),
        key: itemKey('yesno', imageUrl(offer.imageKey)),
        src: imageUrl(offer.imageKey),
        width: offer.width,
        height: offer.height,
      },
    };
  }
  if (!feed) return null;

  const hiddenConfig = await hiddenSettings();
  const hidden = await pickHiddenCheck(db, {
    userId,
    rank,
    secret,
    questionKey: feed.question.key,
    rate: hiddenConfig.rate,
    probationShare: hiddenConfig.probationShare,
    exclude: skipped?.hidden,
    slot,
  });
  if (hidden) {
    return {
      banner: null,
      category: null,
      question: hidden.question,
      item: {
        id: sealItem(secret, userId, { kind: 'hidden', id: hidden.referenceId }),
        key: itemKey(hidden.question.key, imageUrl(hidden.imageKey)),
        src: imageUrl(hidden.imageKey),
        width: hidden.width,
        height: hidden.height,
      },
    };
  }

  const [item] = feed.items;
  return {
    banner: null,
    category: null,
    question: feed.question,
    item: {
      id: sealItem(secret, userId, { kind: 'queue', id: item.id }),
      key: itemKey(feed.question.key, imageUrl(item.imageKey)),
      src: imageUrl(item.imageKey),
      width: item.width,
      height: item.height,
    },
  };
}
