import {
  ActionIcon,
  Badge,
  Button,
  Container,
  createStyles,
  Group,
  Menu,
  Stack,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconCheck, IconDotsVertical, IconEdit, IconHeart, IconTrash, IconX } from '@tabler/icons';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { DeleteQuestion } from '~/components/Questions/DeleteQuestion';
import { QuestionHeader } from '~/components/Questions/QuestionHeader';
import { QuestionForm } from '~/components/Questions/QuestionForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';
import { QuestionDetail } from '~/components/Questions/QuestionDetail';
import { ReactionButton } from '~/components/Reaction/ReactionButton';
import { AnswerDetail } from '~/components/Questions/AnswerDetail';

export const getServerSideProps: GetServerSideProps<{
  id: number;
  title: string;
}> = async (context) => {
  const params = (context.params ?? {}) as { questionId: string; questionTitle: string };
  const questionId = Number(params.questionId);
  if (!isNumber(questionId))
    return {
      notFound: true,
    };

  const ssg = await getServerProxySSGHelpers(context);
  await ssg.question.getById.prefetch({ id: questionId });

  return {
    props: {
      trpcState: ssg.dehydrate(),
      id: questionId,
      title: params.questionTitle,
    },
  };
};

export function QuestionPage(props: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { id, title } = props;
  const router = useRouter();
  const user = useCurrentUser();
  const editing = router.query.editing;
  const { classes } = useStyles();

  const theme = useMantineTheme();
  const { data: question, isLoading: loadingQuestion } = trpc.question.getById.useQuery({ id });
  const { data: answers } = trpc.answer.getAll.useQuery({ questionId: id });

  const isModerator = user?.isModerator ?? false;
  const isOwner = user?.id === question?.user.id;

  if (!question) return <NotFound />;
  // TODO - inline this with question content instead of displaying as a separate page
  if (editing && question && (isOwner || isModerator)) return <QuestionForm question={question} />;

  return (
    <>
      <Meta
        title={`${title} | Civitai`}
        description={removeTags(question.content ?? '')}
        // TODO - determine if we need to do anything to handle content that has images/videos in it
      />
      <Container className={classes.grid}>
        <div className={classes.fullWidth}>
          <QuestionHeader question={question} />
        </div>
        <div className={classes.row}>
          <div>
            <ReactionButton
              reactionId={question.userReaction?.id}
              reactionType="heart"
              userReaction={question.userReaction?.heart}
              count={question.metrics?.heartCountAllTime}
              entityType="question"
              entityId={question.id}
              disabled={question.user.id === user?.id}
            />
          </div>
          <Stack>
            <QuestionDetail question={question} />
            {/* TODO comments */}
          </Stack>
        </div>
        {!!answers?.length && (
          <Group className={classes.fullWidth} noWrap>
            <Title order={2}>
              {answers.length} {answers.length === 1 ? 'Answer' : 'Answers'}
            </Title>
            {/* TODO - Answer Sorting */}
          </Group>
        )}
        {answers?.map((answer) => (
          <div key={answer.id} className={classes.row}>
            <Stack>
              <ReactionButton
                reactionId={answer.userReaction?.id}
                reactionType="heart"
                userReaction={answer.userReaction?.heart}
                entityType="answer"
                entityId={answer.id}
                count={answer.metrics?.heartCountAllTime}
                disabled={answer.user.id === user?.id}
              />
              <ReactionButton
                reactionId={answer.userReaction?.id}
                reactionType="check"
                userReaction={answer.userReaction?.check}
                entityType="answer"
                entityId={answer.id}
                count={answer.metrics?.checkCountAllTime}
                disabled={answer.user.id === user?.id}
              />
              <ReactionButton
                reactionId={answer.userReaction?.id}
                reactionType="cross"
                userReaction={answer.userReaction?.cross}
                entityType="answer"
                entityId={answer.id}
                count={answer.metrics?.crossCountAllTime}
                disabled={answer.user.id === user?.id}
              />
            </Stack>
            <Stack>
              <AnswerDetail answer={answer} questionId={id} />
              {/* TODO comments */}
            </Stack>
          </div>
        ))}
      </Container>
    </>
  );
}

const useStyles = createStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'min-content 1fr',
  },
  fullWidth: {
    gridColumn: '1/-1',
  },
  row: {
    display: 'contents',
  },
});
