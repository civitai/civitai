import { Anchor, Group, Text, Tooltip } from '@mantine/core';
import { numberWithCommas } from '~/utils/number-helpers';
import Link from 'next/link';

export function ModelVersionReview({ modelId, versionId, thumbsDownCount, thumbsUpCount }: Props) {
  const totalCount = thumbsUpCount + thumbsDownCount;
  const positiveRating = totalCount > 0 ? thumbsUpCount / totalCount : 0;

  if (totalCount === 0) return <Text>No reviews yet</Text>;

  return (
    <Group position="left" align="flex-start" spacing={4}>
      <Tooltip
        label={`${Math.round(positiveRating * 100)}% of the ${numberWithCommas(totalCount)} ${
          totalCount > 1 ? 'reviews' : 'review'
        } are positive`}
      >
        <div>
          <Link href={`/models/${modelId}/reviews?modelVersionId=${versionId}`} passHref>
            <Anchor tt="capitalize">
              <Text>{getRatingLabel({ positiveRating, totalCount })}</Text>
            </Anchor>
          </Link>
        </div>
      </Tooltip>
      <Text>({numberWithCommas(totalCount)})</Text>
    </Group>
  );
}

function getRatingLabel({
  positiveRating,
  totalCount,
}: {
  positiveRating: number;
  totalCount: number;
}) {
  if (positiveRating < 0.2) {
    if (totalCount < 50) return 'Negative';
    else if (totalCount < 500) return 'Very negative';
    else return 'Overwhelmingly negative';
  } else if (positiveRating < 0.4) {
    return 'Mostly negative';
  } else if (positiveRating < 0.7) {
    return 'Mixed';
  } else if (positiveRating < 0.8) {
    return 'Mostly positive';
  } else {
    if (totalCount < 50) return 'Positive';
    else if (totalCount < 500) return 'Very positive';
    else if (totalCount >= 500 && positiveRating < 0.95) return 'Very Positive';
    else return 'Overwhelmingly positive';
  }
}

type Props = { modelId: number; versionId: number; thumbsUpCount: number; thumbsDownCount: number };
