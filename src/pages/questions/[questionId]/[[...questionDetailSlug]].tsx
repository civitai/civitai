import {
  ActionIcon,
  Badge,
  Button,
  Container,
  createStyles,
  Divider,
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
import { AnswerForm } from '~/components/Questions/AnswerForm';
import { useEffect } from 'react';
import { ReviewReactions } from '@prisma/client';
import { AnswerVotes } from '~/components/Questions/AnswerVotes';
import { prisma } from '~/server/db/client';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps<{
  id: number;
  title: string;
}> = async (context) => {
  const params = (context.params ?? {}) as {
    questionId: string;
    questionDetailSlug: string[] | undefined;
  };
  const questionId = Number(params.questionId);
  const questionTitle = params.questionDetailSlug?.[0];
  if (!isNumber(questionId))
    return {
      notFound: true,
    };

  if (!questionTitle) {
    const question = await prisma.question.findUnique({
      where: { id: questionId },
      select: { title: true },
    });
    if (question?.title) {
      const [pathname, query] = context.resolvedUrl.split('?');
      let destination = `${pathname}/${slugit(question.title)}`;
      if (query) destination += `?${query}`;
      return {
        redirect: {
          permanent: false,
          destination,
        },
      };
    }
    return {
      notFound: true,
    };
  }

  const ssg = await getServerProxySSGHelpers(context);
  await ssg.question.getById.prefetch({ id: questionId });
  await ssg.answer.getAll.prefetch({ questionId });

  return {
    props: {
      trpcState: ssg.dehydrate(),
      id: questionId,
      title: questionTitle,
    },
  };
};

export default function QuestionPage(
  props: InferGetServerSidePropsType<typeof getServerSideProps>
) {
  const { id, title } = props;
  const router = useRouter();
  const user = useCurrentUser();
  const editing = router.query.edit;
  const { classes } = useStyles();

  const theme = useMantineTheme();
  const { data: question, isLoading: loadingQuestion } = trpc.question.getById.useQuery({ id });
  const { data: answers } = trpc.answer.getAll.useQuery({ questionId: id });

  useEffect(() => console.log({ answers }), [answers]);

  const isModerator = user?.isModerator ?? false;
  const isOwner = user?.id === question?.user.id;

  useEffect(() => {
    if (!title) {
      router.replace({});
    }
  }, [router, title]);

  if (!question) return <NotFound />;
  // TODO - inline this with question content instead of displaying as a separate page
  if (editing && question && (isOwner || isModerator)) return <QuestionForm question={question} />;

  return (
    <>
      <Meta
        title={`${question.title} | Civitai`}
        description={removeTags(question.content ?? '')}
        // TODO - determine if we need to do anything to handle content that has images/videos in it
      />
      <Container className={classes.grid} pb="xl">
        <div className={classes.fullWidth}>
          <QuestionHeader question={question} />
        </div>
        <Divider className={classes.fullWidth} my="md" />
        <div className={classes.row}>
          <div>
            <ReactionButton
              reaction={ReviewReactions.Heart}
              userReacted={question.userReactions.some((x) => x.reaction === ReviewReactions.Heart)}
              count={question.rank?.heartCountAllTime}
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
        <div className={classes.fullWidth}>
          {!!answers?.length ? (
            <Group noWrap>
              <Title order={2}>
                {answers.length} {answers.length === 1 ? 'Answer' : 'Answers'}
              </Title>
              {/* TODO - Answer Sorting */}
            </Group>
          ) : null}
        </div>

        {answers?.map((answer, index) => (
          <div key={answer.id} className={classes.row}>
            <Stack spacing="xs">
              <ReactionButton
                reaction={ReviewReactions.Heart}
                userReacted={answer.userReactions.some((x) => x.reaction === ReviewReactions.Heart)}
                count={answer.rank?.heartCountAllTime}
                entityType="answer"
                entityId={answer.id}
                disabled={answer.user.id === user?.id}
              />
              <AnswerVotes
                userVote={answer.userVote?.vote}
                answerId={answer.id}
                crossCount={answer.rank?.crossCountAllTime}
                checkCount={answer.rank?.checkCountAllTime}
                disabled={answer.user.id === user?.id}
              >
                <AnswerVotes.Check />
                <AnswerVotes.Cross />
              </AnswerVotes>
            </Stack>
            <Stack>
              <AnswerDetail answer={answer} questionId={id} />
              {index !== answers.length - 1 && <Divider />}
              {/* TODO comments */}
            </Stack>
          </div>
        ))}
        {!answers?.some((x) => x.user.id === user?.id) && (
          <Stack className={classes.fullWidth}>
            <Title order={3}>Your anwser</Title>
            <AnswerForm questionId={id} />
          </Stack>
        )}
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'min-content 1fr',
    columnGap: theme.spacing.md,
    rowGap: theme.spacing.md,
  },
  fullWidth: {
    gridColumn: '1/-1',
  },
  row: {
    display: 'contents',
  },
}));
