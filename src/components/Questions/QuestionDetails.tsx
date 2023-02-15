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
  createStyles,
} from '@mantine/core';
import { ReviewReactions } from '@prisma/client';
import { FavoriteBadge } from '~/components/Questions/FavoriteBadge';
import { ReactionBadge } from '~/components/Questions/ReactionBadge';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { QuestionDetailProps } from '~/server/controllers/question.controller';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { IconDotsVertical, IconEdit, IconMessageCircle, IconTrash } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NextLink } from '@mantine/next';
import { DeleteQuestion } from '~/components/Questions/DeleteQuestion';
import { QuestionAnswerComments } from '~/components/Questions/QuestionAnswerComments';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';

export function QuestionDetails({ question }: { question: QuestionDetailProps }) {
  const user = useCurrentUser();
  const theme = useMantineTheme();
  const router = useRouter();
  const questionTitle = router.query.questionTitle;

  const [showComments, setShowComments] = useState(false);

  const { data: count = 0 } = trpc.commentv2.getCount.useQuery(
    { entityId: question.id, entityType: 'question' },
    { initialData: question.thread?._count.comments }
  );

  const isModerator = user?.isModerator ?? false;
  const isOwner = user?.id === question?.user.id;
  const isMuted = user?.muted ?? false;

  const { classes } = useStyles();

  return (
    <Card p="sm" withBorder>
      <Stack spacing="xs">
        <Group position="apart" noWrap align="center">
          <Title>{question.title}</Title>
          {/* TODO - add additional actions and remove condition here */}
          {(isOwner || isModerator) && (
            <Menu position="bottom-end" transition="pop-top-right">
              <Menu.Target>
                <ActionIcon variant="outline">
                  <IconDotsVertical size={16} />
                </ActionIcon>
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
                        component={NextLink}
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
        <Group spacing={4}>
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
        <Group spacing="xs" position="apart">
          <FavoriteBadge
            userReacted={question.userReactions.some((x) => x.reaction === ReviewReactions.Heart)}
            count={question.rank?.heartCountAllTime}
            entityType="question"
            entityId={question.id}
          />
          <ReactionBadge
            color={showComments ? 'blue' : undefined}
            leftIcon={<IconMessageCircle size={18} />}
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
              initialData={question.thread?.comments}
              initialCount={question.thread?._count.comments}
              userId={question.user.id}
            />
          </Card.Section>
        )}
      </Stack>
    </Card>
  );
}

const useStyles = createStyles((theme) => {
  const borderColor = theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3];
  return {
    list: {
      borderTop: `1px solid ${borderColor}`,
    },
    listItem: {
      padding: theme.spacing.sm,
      borderBottom: `1px solid ${borderColor}`,
    },
  };
});
