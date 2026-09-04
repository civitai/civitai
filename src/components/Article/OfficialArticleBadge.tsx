import { Badge, Tooltip } from '@mantine/core';
import { IconRosetteDiscountCheck } from '@tabler/icons-react';
import clsx from 'clsx';

import { OFFICIAL_ARTICLE_LABEL } from '~/shared/constants/official-article.constants';

/**
 * The marker on an article published by Civitai rather than by a community author.
 *
 * One component for both surfaces — the card and the article page — because this badge is
 * a claim about provenance, and two hand-maintained copies of a provenance marker is how
 * one of them ends up looking like an ordinary chip. `className` is the only thing a
 * caller varies; the card passes its own chip class so the badge sits in the card's
 * header rhythm.
 *
 * 🔴 Rendering this is NOT what makes an article official. The tag behind it is
 * `adminOnly`, and `upsertArticleHandler` is what refuses it from a non-moderator. Do not
 * reuse this badge for anything a user can set about themselves.
 */
export function OfficialArticleBadge({ className }: { className?: string }) {
  return (
    <Tooltip label="Published by Civitai" withArrow>
      <Badge
        size="sm"
        variant="filled"
        color="blue"
        className={clsx('uppercase', className)}
        leftSection={<IconRosetteDiscountCheck size={14} stroke={2.5} />}
      >
        {OFFICIAL_ARTICLE_LABEL}
      </Badge>
    </Tooltip>
  );
}
