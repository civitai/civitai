import { Container, Stack, Group, createStyles, Box, Center, Title, Text } from '@mantine/core';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next/types';
import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import {
  InfiniteModelsSort,
  InfiniteModelsPeriod,
  InfiniteModelsFilter,
} from '~/components/InfiniteModels/InfiniteModelsFilters';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const ssg = await getServerProxySSGHelpers(ctx);
  const tagname = ctx.query.tagname as string;
  if (tagname) await ssg.tag.getTagWithModelCount.prefetch({ name: tagname });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

export default function TagPage() {
  const { classes } = useStyles();
  const router = useRouter();
  const tagname = router.query.tagname as string;

  const { data: tag } = trpc.tag.getTagWithModelCount.useQuery({ name: tagname });
  const count = tag?._count.tagsOnModels ?? 0;

  return (
    <>
      <Head>
        <meta name="description" content="Community driven AI model sharing tool" />
      </Head>
      {tag && (
        <Box className={classes.banner} mb="md">
          <Center>
            <Stack spacing="xs">
              <Title order={1} align="center">
                {tag.name}
              </Title>
              <Text transform="uppercase" align="center">
                {count} {count === 1 ? 'model' : 'models'}
              </Text>
            </Stack>
          </Center>
        </Box>
      )}
      <Container size="xl">
        <Stack spacing="xs">
          <Group position="apart">
            <InfiniteModelsSort />
            <Group spacing="xs">
              <InfiniteModelsPeriod />
              <InfiniteModelsFilter />
            </Group>
          </Group>
          <InfiniteModels />
        </Stack>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  banner: {
    marginTop: `-${theme.spacing.md}px`,
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.xl * 2,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],

    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.md,
    },
  },
  image: {
    width: '128px',
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  wrapper: {
    alignItems: 'flex-start',
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      alignItems: 'center',
    },
  },
  outsideImage: {
    display: 'none',
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      display: 'block',
    },
  },
  insideImage: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      display: 'none',
    },
  },
  card: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      width: '100%',
    },
  },
}));
