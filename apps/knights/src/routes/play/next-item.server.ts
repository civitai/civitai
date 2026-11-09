import { imageUrl } from '$lib/server/image-url';
import { sealItem } from '$lib/server/feed-token';
import { pickHiddenCheck } from '$lib/server/hidden/hidden.service';
import { hiddenSettings } from '$lib/server/hidden/runtime';
import { getFeed } from '$lib/server/queue/queue.service';
import { feedSecret } from '$lib/server/smites/runtime';
import type { Skipped } from '$lib/server/skips';
import { pickYesNo } from '$lib/server/yesno/feed';
import { YESNO_ANSWERS } from '$lib/server/yesno/keys';
import { yesNoConfig } from '$lib/server/yesno/runtime';
import { db } from '$lib/server/db';
import { itemKey, type PickedItem } from './optimistic';

/**
 * The next thing to judge: a hidden check first, so its rate holds whatever the yes/no share is (it only rides on a
 * rating question), then a yes/no question if one is rolled (or when there is no rating to show), then the queue.
 * `slot` rolls for an item the player has not reached yet; unset, the roll is fixed by their last vote.
 */
export async function pickItem(
  userId: number,
  rank: string,
  skipped: Skipped | null,
  slot?: number,
  /** Yes/no question ids already handed out ahead of the player, oldest first: the stretch counts them. */
  ahead?: number[]
): Promise<PickedItem | null> {
  const feed = await getFeed(db, userId, { limit: 1, exclude: skipped?.queue });
  const secret = feedSecret();

  if (feed) {
    const hidden = await pickHiddenCheck(db, {
      userId,
      rank,
      secret,
      questionKey: feed.question.key,
      rate: hiddenSettings().rate,
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
  }

  const yesNo = yesNoConfig();
  const offer =
    yesNo.share <= 0
      ? null
      : await pickYesNo(db, {
          userId,
          rank,
          secret,
          share: yesNo.share,
          stretch: yesNo.stretch,
          force: !feed,
          exclude: skipped?.yesno,
          ahead,
          slot,
        });
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
