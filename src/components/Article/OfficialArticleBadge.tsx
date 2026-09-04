import { IconRosetteDiscountCheck } from '@tabler/icons-react';

import { IconBadge } from '~/components/IconBadge/IconBadge';

/**
 * The marker on an article published by Civitai rather than by a community author.
 *
 * Driven by `Article.isOfficial` — a column with a moderator-only setter
 * (`setArticleOfficial`, mounted on `moderatorProcedure`), mirroring `Model.isOfficial`.
 * 🔴 It is a provenance claim, so never render it from anything a user can set about their
 * own content, and never derive it from a tag name: the design this replaced did exactly
 * that, and article tags attach by name through `connectOrCreate`, so the marker was a
 * string any user could type.
 *
 * Built on `IconBadge` rather than composing `Badge` + `Tooltip` by hand, so the
 * icon-to-text gap and the horizontal padding stay the ones every other icon badge on the
 * card uses. `IconRosetteDiscountCheck` is the same icon the model moderator menu uses for
 * Mark Official, which is the point — one provenance concept should not look like two.
 *
 * One component for both surfaces (the card and the article page) on purpose. Two
 * hand-maintained copies of a provenance marker is how one of them ends up looking like an
 * ordinary chip.
 */
export function OfficialArticleBadge({ className }: { className?: string }) {
  return (
    <IconBadge
      className={className}
      color="blue"
      variant="filled"
      size="sm"
      tooltip="Published by Civitai"
      icon={<IconRosetteDiscountCheck size={14} stroke={2.5} />}
    >
      Official
    </IconBadge>
  );
}
