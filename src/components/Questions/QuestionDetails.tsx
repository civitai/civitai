import {
  Stack,
  Group,
  useMantineTheme,
  ActionIcon,
  Badge,
  Card,
  Divider,
  Menu,
  Title,
} from '@mantine/core';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import { FavoriteBadge } from '~/components/Questions/FavoriteBadge';
import { ReactionBadge } from '~/components/Questions/ReactionBadge';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { QuestionDetailProps } from '~/server/controllers/question.controller';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { IconDotsVertical, IconEdit, IconMessageCircle, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { DeleteQuestion } from '~/components/Questions/DeleteQuestion';
import { QuestionAnswerComments } from '~/components/Questions/QuestionAnswerComments';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function QuestionDetails({ question }: { question: QuestionDetailProps }) {
  const user = useCurrentUser();
  const theme = useMantineTheme();
  const router = useRouter();
  const questionTitle = router.query.questionTitle;

  const [showComments, setShowComments] = useState(false);

  const { data: count = 0 } = trpc.commentv2.getCount.useQuery(
    { entityId: question.id, entityType: 'question' },
    { initialData: question.thread?._count.comments ?? 0 }
  );

  const isModerator = user?.isModerator ?? false;
  const isOwner = user?.id === question?.user.id;
  const isMuted = user?.muted ?? false;

  return (
    <Card p="sm" withBorder>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="center">
          <Title order={1}>{question.title}</Title>
          {/* TODO - add additional actions and remove condition here */}
          {(isOwner || isModerator) && (
            <Menu position="bottom-end" transitionProps={{ transition: 'pop-top-right' }}>
              <Menu.Target>
                <LegacyActionIcon variant="outline">
                  <IconDotsVertical size={16} />
                </LegacyActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {(isOwner || isModerator) && (
                  <>
                    <DeleteQuestion id={question.id}>
                      <Menu.Item
                        color={theme.colors.red[6]}
                        icon={<IconTrash size={14} stroke={1.5} />}
                      >
                        Delete Question
                      </Menu.Item>
                    </DeleteQuestion>
                    {(!isMuted || isModerator) && (
                      <Menu.Item
                        component={Link}
                        href={`/questions/${question.id}/${questionTitle}?edit=true`}
                        icon={<IconEdit size={14} stroke={1.5} />}
                        shallow
                      >
                        Edit question
                      </Menu.Item>
                    )}
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
        <Group gap={4}>
          {question.tags.map((tag) => (
            <Badge key={tag.id} color="blue" component="a" size="sm" radius="sm">
              {tag.name}
            </Badge>
          ))}
        </Group>
      </Stack>

      <Divider my="md" />
      <Stack>
        <UserAvatar
          user={question.user}
          subText={<DaysFromNow date={question.createdAt} />}
          subTextForce
          withUsername
          linkToProfile
        />
        <RenderHtml html={question.content} />
        <Group gap="xs" justify="space-between">
          <FavoriteBadge
            userReacted={question.userReactions.some((x) => x.reaction === ReviewReactions.Heart)}
            count={question.rank?.heartCountAllTime}
            entityType="question"
            entityId={question.id}
          />
          <ReactionBadge
            color={showComments ? 'blue' : undefined}
            leftSection={<IconMessageCircle size={18} />}
            onClick={() => setShowComments((v) => !v)}
            tooltip="Comments"
          >
            {count}
          </ReactionBadge>
        </Group>
        {showComments && (
          <Card.Section>
            <QuestionAnswerComments
              entityId={question.id}
              entityType="question"
              initialCount={question.thread?._count.comments ?? 0}
              userId={question.user.id}
            />
          </Card.Section>
        )}
      </Stack>
    </Card>
  );
}
