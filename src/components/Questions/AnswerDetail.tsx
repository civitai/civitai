import { ActionIcon, Button, Group, Menu, Stack, useMantineTheme, Card } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { GetAnswersProps } from '~/server/controllers/answer.controller';
import { useState } from 'react';
import { AnswerForm } from '~/components/Questions/AnswerForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { DeleteAnswer } from '~/components/Questions/DeleteAnswer';
import { IconDotsVertical, IconTrash, IconEdit, IconMessageCircle } from '@tabler/icons';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ReviewReactions } from '@prisma/client';
import { AnswerVotes } from '~/components/Questions/AnswerVotes';
import { FavoriteBadge } from '~/components/Questions/FavoriteBadge';
import { QuestionDetailProps } from '~/server/controllers/question.controller';
import { ReactionBadge } from '~/components/Questions/ReactionBadge';
import { trpc } from '~/utils/trpc';
import { QuestionAnswerComments } from '~/components/Questions/QuestionAnswerComments';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';

export function AnswerDetail({
  answer,
  question,
}: {
  answer: GetAnswersProps[0];
  question: QuestionDetailProps;
}) {
  const theme = useMantineTheme();
  const user = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const [showComments, setShowComments] = useState(false);

  const isModerator = user?.isModerator ?? false;
  const isOwner = user?.id === answer?.user.id;
  const isMuted = user?.muted ?? false;

  const { data: count = 0 } = trpc.commentv2.getCount.useQuery(
    { entityId: answer.id, entityType: 'answer' },
    { initialData: answer.thread?._count.comments }
  );

  if (editing)
    return (
      <AnswerForm answer={answer} questionId={question.id} onCancel={() => setEditing(false)} />
    );

  return (
    <Card p="sm" withBorder>
      <Stack>
        <Group position="apart">
          <UserAvatar
            user={answer.user}
            subText={<DaysFromNow date={answer.createdAt} />}
            subTextForce
            withUsername
            linkToProfile
          />
          {/* TODO - menu item for reporting */}
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
                    <DeleteAnswer id={answer.id}>
                      <Menu.Item
                        color={theme.colors.red[6]}
                        icon={<IconTrash size={14} stroke={1.5} />}
                      >
                        Delete answer
                      </Menu.Item>
                    </DeleteAnswer>
                    {(!isMuted || isModerator) && (
                      <Menu.Item
                        icon={<IconEdit size={14} stroke={1.5} />}
                        onClick={() => setEditing(true)}
                      >
                        Edit answer
                      </Menu.Item>
                    )}
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
        <RenderHtml html={answer.content} />
        <Group position="apart">
          <Button.Group>
            <FavoriteBadge
              userReacted={answer.userReactions.some((x) => x.reaction === ReviewReactions.Heart)}
              count={answer.rank?.heartCountAllTime}
              entityType="answer"
              entityId={answer.id}
            />
            <AnswerVotes
              userVote={answer.userVote?.vote}
              answerId={answer.id}
              crossCount={answer.rank?.crossCountAllTime}
              checkCount={answer.rank?.checkCountAllTime}
              questionId={question.id}
              questionOwnerId={question.user.id}
            >
              <AnswerVotes.Check />
              <AnswerVotes.Cross />
            </AnswerVotes>
          </Button.Group>
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
              entityId={answer.id}
              entityType="answer"
              initialData={answer.thread?.comments}
              initialCount={answer.thread?._count.comments}
              userId={answer.user.id}
            />
          </Card.Section>
        )}
      </Stack>
    </Card>
  );
}
