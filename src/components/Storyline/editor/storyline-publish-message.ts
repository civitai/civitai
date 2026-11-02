import { STORYLINE_QUEUE_SENT_URL } from '~/components/Placement/queue-routes';
import type { StorylinePublishOutcome } from '~/server/services/storyline-publish.service';
import {
  browsingLevelLabels,
  getBrowsingLevelLabel,
} from '~/shared/constants/browsingLevel.constants';

export type StorylinePublishMessage = {
  title?: string;
  message: string;
  color: 'teal' | 'yellow' | 'red';
  /** Where to follow it up; a message with one stays until dismissed. */
  link?: { href: string; label: string };
};

/** What publishing did with the post's storyline draft, in the words the author is shown. */
export function storylinePublishMessage(
  outcome: StorylinePublishOutcome,
  {
    chapterNumber = 1,
    startsBranch = false,
  }: { chapterNumber?: number; startsBranch?: boolean } = {}
): StorylinePublishMessage {
  const chapter = startsBranch ? 'Your branch' : `Chapter ${chapterNumber}`;
  switch (outcome.status) {
    case 'chapterWritten': {
      const raisedTo = outcome.ceilingRaisedTo;
      const rating =
        raisedTo != null ? browsingLevelLabels[raisedTo as keyof typeof browsingLevelLabels] : null;
      return {
        color: 'teal',
        message: rating
          ? `${chapter} is live. Your storyline's maximum rating was raised to ${rating} to fit chapter ${chapterNumber}.`
          : `${chapter} is live.`,
      };
    }
    case 'waiting':
      return { color: 'yellow', message: waitingMessage(outcome, chapter) };
    case 'submitted':
      return {
        color: 'teal',
        title: 'Submitted, waiting for approval',
        message: `${chapter} is waiting for the storyline owner's approval. It joins the story once they accept it.`,
        link: { href: STORYLINE_QUEUE_SENT_URL, label: 'See your sent continuations' },
      };
    case 'dropped':
      return { color: 'red', message: outcome.reason };
  }
}

function waitingMessage(
  { reason, rating }: Extract<StorylinePublishOutcome, { status: 'waiting' }>,
  chapter: string
) {
  switch (reason) {
    case 'notReady':
      return `${chapter} goes live once your images finish checking.`;
    case 'restricted':
      return `${chapter} will be added when your account is able to.`;
    case 'aboveRating':
      return `${chapter} is rated above your storyline's maximum rating, so it hasn't been added.${
        rating
          ? ` Your storyline allows up to ${getBrowsingLevelLabel(
              rating.maxNsfwLevel
            )}; this post is ${getBrowsingLevelLabel(rating.postLevel)}.`
          : ''
      } Raise the rating from Manage on the storyline's page.`;
    case 'cannotSubmit':
      return `${chapter} can't be added with this post's images.`;
  }
}
