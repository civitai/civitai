import {
  Center,
  Container,
  Loader,
  Paper,
  Stack,
  Title,
  Badge,
  Group,
  createStyles,
} from '@mantine/core';
import { IconHeart, IconMessageCircle } from '@tabler/icons';
import { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const page = Number(context.query.page ?? 1);
  const tagname = context.query.tagname
    ? ([] as string[]).concat(context.query.tagname)[0]
    : undefined;

  const ssg = await getServerProxySSGHelpers(context);
  await ssg.question.getPaged.prefetch({ page, tagname, limit: 0 });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

export default function Questions() {
  const router = useRouter();
  const page = Number(router.query.page ?? 1);
  const tagname = router.query.tagname
    ? ([] as string[]).concat(router.query.tagname)[0]
    : undefined;

  const { data: questions, isLoading } = trpc.question.getPaged.useQuery({
    page,
    tagname,
    limit: 0,
  });

  const { classes } = useStyles();

  return (
    <Container pb="xl">
      <Stack spacing="xl">
        {/* TODO - filters */}
        {!questions?.items?.length ? (
          <Center>
            <Loader />
          </Center>
        ) : (
          <Stack spacing="sm">
            {questions.items.map((question) => (
              <Link
                key={question.id}
                href={`/questions/${question.id}/${slugit(question.title)}`}
                passHref
              >
                <a>
                  <Paper withBorder p="sm">
                    <Stack spacing="xs">
                      <Title order={3} className={classes.title}>
                        {question.title}
                      </Title>
                      <Group position="apart">
                        <Group spacing={4}>
                          {question.tags.map((tag, index) => (
                            <Badge key={index}>{tag.name}</Badge>
                          ))}
                        </Group>
                        <Group spacing={4}>
                          <Badge
                            leftSection={
                              <Center>
                                <IconHeart size={16} />
                              </Center>
                            }
                          >
                            {question.rank.heartCount}
                          </Badge>
                          <Badge
                            color="green"
                            leftSection={
                              <Center>
                                <IconMessageCircle size={16} />
                              </Center>
                            }
                          >
                            {question.rank.answerCount}
                          </Badge>
                        </Group>
                      </Group>
                    </Stack>
                  </Paper>
                </a>
              </Link>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

const useStyles = createStyles((theme) => ({
  title: {
    overflowWrap: 'break-word',
  },
}));
