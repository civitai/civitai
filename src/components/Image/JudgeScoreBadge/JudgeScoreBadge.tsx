import { Badge, Divider, Group, Loader, Popover, Progress, Stack, Text } from '@mantine/core';
import { IconStarFilled } from '@tabler/icons-react';
import type { MouseEvent } from 'react';
import { useState } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { JudgeInfo } from '~/components/Image/Providers/ImagesProvider';
import { trpc } from '~/utils/trpc';

type JudgeScore = {
  theme: number;
  wittiness: number;
  humor: number;
  aesthetic: number;
};

const categories: { key: keyof JudgeScore; label: string }[] = [
  { key: 'theme', label: 'Theme' },
  { key: 'wittiness', label: 'Wittiness' },
  { key: 'humor', label: 'Humor' },
  { key: 'aesthetic', label: 'Aesthetic' },
];

function getScoreColor(score: number) {
  if (score >= 8) return 'green';
  if (score >= 6) return 'yellow';
  if (score >= 4) return 'orange';
  return 'red';
}

export function JudgeScoreBadge({
  score,
  imageId,
  judgeInfo,
}: {
  score: JudgeScore;
  imageId?: number;
  judgeInfo?: JudgeInfo;
}) {
  const [opened, setOpened] = useState(false);
  const avg = (score.theme + score.wittiness + score.humor + score.aesthetic) / 4;
  const avgRounded = Math.round(avg * 10) / 10;

  const hasJudge = !!imageId && !!judgeInfo;

  const { data: judgeComment, isLoading: commentLoading } = trpc.challenge.getJudgeComment.useQuery(
    { imageId: imageId!, judgeUserId: judgeInfo?.userId ?? 0 },
    { enabled: opened && hasJudge }
  );

  return (
    <Popover opened={opened} onChange={setOpened} withArrow withinPortal shadow="md" width={240}>
      <Popover.Target>
        <Badge
          color={getScoreColor(avg)}
          radius="xl"
          h={26}
          variant="filled"
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOpened((o) => !o);
          }}
          style={{ cursor: 'pointer', flexShrink: 0, boxShadow: '1px 2px 3px -1px #25262B33' }}
          leftSection={<IconStarFilled size={12} />}
        >
          {avgRounded.toFixed(1)}
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
          {categories.map(({ key, label }) => (
            <div key={key}>
              <Group justify="space-between" mb={2}>
                <Text size="xs">{label}</Text>
                <Text size="xs" fw={600}>
                  {score[key]}/10
                </Text>
              </Group>
              <Progress value={score[key] * 10} color={getScoreColor(score[key])} size="sm" />
            </div>
          ))}
          <Group
            justify="space-between"
            mt={4}
            style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}
            pt={4}
          >
            <Text size="xs" fw={600}>
              Average
            </Text>
            <Text size="xs" fw={700} c={getScoreColor(avg)}>
              {avgRounded.toFixed(1)}/10
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
