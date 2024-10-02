import { Group, MantineColor, Text, Tooltip } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { numberWithCommas } from '~/utils/number-helpers';

export function ModelVersionReview({ modelId, versionId, thumbsDownCount, thumbsUpCount }: Props) {
  const totalCount = thumbsUpCount + thumbsDownCount;
  const positiveRating = totalCount > 0 ? thumbsUpCount / totalCount : 0;

  if (totalCount === 0) return <Text>No reviews yet</Text>;

  const { label, color } = getRatingLabel({ positiveRating, totalCount });

  return (
    <Group position="left" align="flex-start" spacing={4}>
      <Tooltip
        label={`${Math.round(positiveRating * 100)}% of reviews are positive`}
        openDelay={500}
        color="gray"
      >
        <div>
          <Text
            component={NextLink}
            href={`/models/${modelId}/reviews?modelVersionId=${versionId}`}
            tt="capitalize"
            variant="link"
            color={color}
          >
            {label}
          </Text>
        </div>
      </Tooltip>
      <Text color="dimmed">({numberWithCommas(totalCount)})</Text>
    </Group>
  );
}

type RatingLabel = { label: string; color: MantineColor };
function getRatingLabel({
  positiveRating,
  totalCount,
}: {
  positiveRating: number;
  totalCount: number;
}): RatingLabel {
  if (positiveRating < 0.2) {
    if (totalCount < 10) return { label: 'Mixed', color: 'yellow' };
    else if (totalCount < 50) return { label: 'Negative', color: 'red' };
    else if (totalCount < 500) return { label: 'Very Negative', color: 'red' };
    else return { label: 'Overwhelmingly negative', color: 'red' };
  } else if (positiveRating < 0.4) {
    return { label: 'Mostly negative', color: 'orange' };
  } else if (positiveRating < 0.7) {
    return { label: 'Mixed', color: 'yellow' };
  } else if (positiveRating < 0.8) {
    return { label: 'Mostly Positive', color: 'lime' };
  } else {
    if (totalCount < 50) return { label: 'Positive', color: 'green' };
    else if (totalCount < 500) return { label: 'Very Positive', color: 'green' };
    else if (totalCount >= 500 && positiveRating < 0.95)
      return { label: 'Very Positive', color: 'green' };
    else return { label: 'Overwhelmingly Positive', color: 'green' };
  }
}

type Props = { modelId: number; versionId: number; thumbsUpCount: number; thumbsDownCount: number };
