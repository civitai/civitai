import { Badge, Divider, Group, Loader, Popover, Progress, Stack, Text } from '@mantine/core';
import { IconStarFilled } from '@tabler/icons-react';
import type { MouseEvent } from 'react';
import { useState } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { JudgeInfo } from '~/components/Image/Providers/ImagesProvider';
import { trpc } from '~/utils/trpc';
import {
  type JudgeScore,
  type JudgingCategory,
  FIXED_JUDGING_CATEGORIES,
  isFixedJudgeScore,
  lookupCategoryScore,
  resolveDisplayScore,
} from '~/server/games/daily-challenge/daily-challenge-scoring';

const CIVCHAN_USER_ID = 7665867;

function getScoreColor(score: number, vibrant?: boolean) {
  if (vibrant) {
    if (score >= 8) return 'pink';
    if (score >= 6) return 'grape';
    if (score >= 4) return 'violet';
    return 'red';
  }
  if (score >= 8) return 'green';
  if (score >= 6) return 'yellow';
  if (score >= 4) return 'orange';
  return 'red';
}

export function JudgeScoreBadge({
  score,
  imageId,
  judgeInfo,
  judgingCategories,
  size = 'sm',
}: {
  score: JudgeScore | Record<string, number>;
  imageId?: number;
  judgeInfo?: JudgeInfo;
  judgingCategories?: JudgingCategory[] | null;
  size?: 'xs' | 'sm';
}) {
  const [opened, setOpened] = useState(false);
  const rubric = judgingCategories?.length
    ? judgingCategories
    : isFixedJudgeScore(score)
    ? FIXED_JUDGING_CATEGORIES
    : null;
  const weighted = resolveDisplayScore(score, judgingCategories) ?? 0;
  const weightedRounded = Math.round(weighted * 10) / 10;

  const hasJudge = !!imageId && !!judgeInfo;
  const vibrant = judgeInfo?.userId === CIVCHAN_USER_ID;
  const isXs = size === 'xs';

  const { data: judgeComment, isLoading: commentLoading } = trpc.challenge.getJudgeComment.useQuery(
    { imageId: imageId!, judgeUserId: judgeInfo?.userId ?? 0 },
    { enabled: opened && hasJudge }
  );

  return (
    <Popover opened={opened} onChange={setOpened} withArrow withinPortal shadow="md" width={240}>
      <Popover.Target>
        <Badge
          color={getScoreColor(weighted, vibrant)}
          radius="xl"
          h={isXs ? 20 : 26}
          variant="filled"
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOpened((o) => !o);
          }}
          style={{
            cursor: 'pointer',
            flexShrink: 0,
            boxShadow: '1px 2px 3px -1px #25262B33',
            fontSize: isXs ? 10 : undefined,
            paddingInline: isXs ? 6 : undefined,
          }}
          leftSection={<IconStarFilled size={isXs ? 9 : 12} />}
        >
          {weightedRounded.toFixed(1)}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Stack gap={8}>
          {hasJudge && (
            <>
              <Group gap="xs">
                <UserAvatar
                  user={{
                    id: judgeInfo.userId,
                    username: judgeInfo.username,
                    profilePicture: judgeInfo.profilePicture ?? undefined,
                  }}
                  size="sm"
                  includeAvatar
                  withUsername={false}
                />
                <Text size="sm" fw={600}>
                  {judgeInfo.username}
                </Text>
              </Group>
              <Divider />
            </>
          )}
          <Text size="sm" fw={600}>
            {hasJudge ? 'Scores' : 'Judge Scores'}
          </Text>
          {rubric
            ? rubric.map(({ key, label, weight }) => {
                const value = lookupCategoryScore(score, label);
                return (
                  <div key={key}>
                    <Group justify="space-between" mb={2}>
                      <Text size="xs">
                        {label}{' '}
                        <Text span size="xs" c="dimmed">
                          ({Math.round(weight)}%)
                        </Text>
                      </Text>
                      <Text size="xs" fw={600}>
                        {value}/10
                      </Text>
                    </Group>
                    <Progress value={value * 10} color={getScoreColor(value, vibrant)} size="sm" />
                  </div>
                );
              })
            : Object.entries(score).map(([key, value]) => (
                <div key={key}>
                  <Group justify="space-between" mb={2}>
                    <Text size="xs">{key}</Text>
                    <Text size="xs" fw={600}>
                      {value}/10
                    </Text>
                  </Group>
                  <Progress value={value * 10} color={getScoreColor(value, vibrant)} size="sm" />
                </div>
              ))}
          <Group
            justify="space-between"
            mt={4}
            style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}
            pt={4}
          >
            <Text size="xs" fw={600}>
              {rubric ? 'Weighted Score' : 'Average Score'}
            </Text>
            <Text size="xs" fw={700} c={getScoreColor(weighted, vibrant)}>
              {weightedRounded.toFixed(1)}/10
            </Text>
          </Group>
          {hasJudge && (commentLoading || judgeComment) && (
            <>
              <Divider />
              {commentLoading ? (
                <Group justify="center" py={4}>
                  <Loader size="xs" />
                </Group>
              ) : (
                <div>
                  <Text size="xs" fw={600} mb={4}>
                    Comment
                  </Text>
                  <Text size="xs" style={{ lineHeight: 1.5 }}>
                    {judgeComment}
                  </Text>
                </div>
              )}
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
