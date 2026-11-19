import { Anchor, Group, Text } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { numberWithCommas } from '~/utils/number-helpers';
// 🔴 SHARED LADDER — do not re-inline this. `getRatingLabel` used to be a
// module-private function here; the app-store listing detail renders the same
// verdict, so it lives in one place now (`~/utils/rating-label`) and both
// surfaces consume it. The caller ledger is asserted in
// `src/utils/__tests__/rating-label.test.ts`.
import { getRatingSummary } from '~/utils/rating-label';

export function ModelVersionReview({ modelId, versionId, thumbsDownCount, thumbsUpCount }: Props) {
  const summary = getRatingSummary({ thumbsUp: thumbsUpCount, thumbsDown: thumbsDownCount });
  if (!summary) return <Text size="sm">No reviews yet</Text>;

  const { label, color, percent, total: totalCount } = summary;

  return (
    <Group justify="left" align="flex-start" gap={4}>
      <Tooltip label={`${percent}% of reviews are positive`} openDelay={500}>
        <div>
          <Anchor
            component={Link}
            size="sm"
            href={`/models/${modelId}/reviews?modelVersionId=${versionId}`}
            tt="capitalize"
            c={color}
          >
            {label}
          </Anchor>
        </div>
      </Tooltip>
      <Text size="sm" c="dimmed">
        ({numberWithCommas(totalCount)})
      </Text>
    </Group>
  );
}

type Props = { modelId: number; versionId: number; thumbsUpCount: number; thumbsDownCount: number };
