import { useState } from 'react';
import { useStorylineContinueTerms } from '~/components/Storyline/storyline.data';
import {
  storylineChangedPrice,
  storylineDraftPublish,
  storylineDraftPublishCaption,
  storylineExpectedPrice,
  storylinePriceLabel,
} from '~/components/Storyline/storyline-ui';
import type { StorylineDraftPublish } from '~/components/Storyline/storyline-ui';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import type { RouterOutput } from '~/types/router';
import { showWarningNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type PendingStorylineDraft = RouterOutput['storyline']['getPendingForPost'];

/**
 * The publish button of a post drafted as a continuation of a storyline chapter. `expectedPrice`
 * and the label are read off one plan, so the price sent is the price shown; a contributor's draft
 * is the only one that sends it. Null for a draft that is not a continuation, or that the viewer
 * is not the author of (a moderator's publish does not submit it).
 */
export function useStorylineDraftPublish({
  post,
  pending,
}: {
  post: { user: { id: number } };
  pending: PendingStorylineDraft | null | undefined;
}) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const [rereading, setRereading] = useState(false);

  const parentChapter = pending?.parentChapter ?? null;
  const applies = !!pending && !!parentChapter && currentUser?.id === post.user.id;
  const asOwner = applies && pending.storyline.userId === post.user.id;
  const parentPostId = parentChapter?.postId ?? null;
  const terms = useStorylineContinueTerms(parentPostId ?? 0, {
    enabled: applies && !asOwner && !!parentPostId,
  });

  let plan: StorylineDraftPublish | null = null;
  if (applies && parentChapter) {
    const chapterNumber = parentChapter.depth + 2;
    if (asOwner || parentPostId)
      plan = storylineDraftPublish({
        asOwner,
        chapterNumber,
        terms: terms.data,
        termsPending: terms.isLoading || rereading,
      });
    // The chapter it continues is gone: the server drops the link and posts it on its own.
    else plan = { kind: 'closed', reason: null };
  }

  /** True when the refusal was a changed price: the price is re-read and the writer told. */
  const handleError = async (error: { message: string }) => {
    if (!error.message.startsWith(STORYLINE_REFUSALS.priceChanged) || !parentPostId) return false;
    setRereading(true);
    try {
      await utils.placement.getStorylineContinuePrice.invalidate({ parentPostId });
    } finally {
      setRereading(false);
    }
    const price = storylineChangedPrice(error.message);
    showWarningNotification({
      title: 'The price changed',
      autoClose: 8000,
      message:
        price === null
          ? 'It changed while you were deciding. Check the button, then publish again.'
          : `It is now ${storylinePriceLabel(price)}. Publish again to accept it.`,
    });
    return true;
  };

  return {
    plan,
    label: plan?.kind === 'owner' || plan?.kind === 'contributor' ? plan.label : undefined,
    expectedPrice: storylineExpectedPrice(plan),
    /** No price to send yet, or none that can be read: publishing now would be refused. */
    blocked: plan?.kind === 'pending' || plan?.kind === 'unavailable',
    caption: plan ? storylineDraftPublishCaption(plan) : null,
    handleError,
  };
}
