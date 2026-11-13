import { NotificationCategory } from '~/server/common/enums';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';

const entityNoun: Record<string, string> = {
  Model: 'model',
  Article: 'article',
  Post: 'post',
  Bounty: 'bounty',
  BountyEntry: 'bounty entry',
  Collection: 'collection',
};

export const textScanNotifications = createNotificationProcessor({
  'text-scan-rating-raised': {
    displayName: 'Content rating raised',
    category: NotificationCategory.Moderation,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { entityType, level, title, url } = details as {
        entityType: string;
        level: number;
        title: string | null;
        url: string;
      };
      const noun = entityNoun[entityType] ?? 'content';
      const label = browsingLevelLabels[level as keyof typeof browsingLevelLabels] ?? '?';
      const named = title ? `${noun} "${title}"` : noun;
      return {
        message: `Your ${named} is now rated ${label} based on its text. If you believe this is a mistake, you can dispute the rating on its page.`,
        url,
      };
    },
  },

  // Unlike `text-scan-rating-raised`, no rating dispute to point at: an owner edits the title,
  // which is scanned again.
  'storyline-title-moderated': {
    displayName: 'Storyline title moderated',
    category: NotificationCategory.Moderation,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { storylineId, title, level, takenDown, minor } = details as {
        storylineId: number;
        title: string;
        level?: number;
        takenDown?: boolean;
        minor?: boolean;
      };
      const url = storylineUrl(storylineId);
      const recheck = 'Edit the title to have it checked again.';
      if (takenDown)
        return {
          message: `Your storyline "${title}" is hidden from other readers because of its title. ${recheck}`,
          url,
        };
      if (minor)
        return {
          message: `Your storyline "${title}" can only hold safe-for-work chapters because of its title: chapters rated above PG-13 are hidden and new ones are refused. ${recheck}`,
          url,
        };
      const label = browsingLevelLabels[level as keyof typeof browsingLevelLabels] ?? '?';
      return {
        message: `Your storyline "${title}" is now rated ${label} because of its title, so only readers who browse at that level see it. ${recheck}`,
        url,
      };
    },
  },
});
