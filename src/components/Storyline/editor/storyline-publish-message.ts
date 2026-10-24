import type { StorylinePublishOutcome } from '~/server/services/storyline-publish.service';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';

export type StorylinePublishMessage = {
  message: string;
  color: 'teal' | 'yellow' | 'red';
};

/** What publishing did with the post's storyline draft, in the words the author is shown. */
export function storylinePublishMessage(
  outcome: StorylinePublishOutcome,
  { chapterNumber = 1 }: { chapterNumber?: number } = {}
): StorylinePublishMessage {
  const chapter = `Chapter ${chapterNumber}`;
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
      return { color: 'yellow', message: waitingMessage(outcome.reason, chapter) };
    case 'submitted':
      return { color: 'teal', message: `${chapter} was submitted for the creator's review.` };
    case 'dropped':
      return { color: 'red', message: outcome.reason };
  }
}

function waitingMessage(
  reason: Extract<StorylinePublishOutcome, { status: 'waiting' }>['reason'],
  chapter: string
) {
  switch (reason) {
    case 'notReady':
      return `${chapter} goes live once your images finish checking.`;
    case 'restricted':
      return `${chapter} will be added when your account is able to.`;
    case 'aboveRating':
      return `${chapter} is rated above your storyline's maximum rating, so it hasn't been added. Raise the rating from Manage on the storyline's page.`;
    case 'cannotSubmit':
      return `${chapter} can't be added with this post's images.`;
  }
}
