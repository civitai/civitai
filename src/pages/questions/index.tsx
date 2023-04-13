import { Container, Stack, Title, Group, Button, Badge, Alert, Text } from '@mantine/core';
import { GetServerSideProps } from 'next';
import Link from 'next/link';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';

import { Meta } from '~/components/Meta/Meta';
import { Questions } from '~/components/Questions/Questions.Provider';
import { constants } from '~/server/common/constants';
import { parseCookies } from '~/providers/CookiesProvider';
import { openContextModal } from '@mantine/modals';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx }) => {
    const page = ctx.query.page ? Number(ctx.query.page) : 1;
    const {
      sort = constants.questionFilterDefaults.sort,
      period = constants.questionFilterDefaults.period,
      status,
    } = parseCookies(ctx.req.cookies).questions;

    await ssg?.question.getPaged.prefetch({
      page,
      limit: constants.questionFilterDefaults.limit,
      sort,
      period,
      status,
    });
  },
});

const openModal = () =>
  openContextModal({
    modal: 'questionsInfo',
    title: <Title order={2}>Additional Info</Title>,
    size: 960,
    innerProps: {},
  });

export default function QuestionsList() {
  const currentUser = useCurrentUser();
  const isMuted = currentUser?.muted ?? false;

  return (
    <>
      <Meta title="Questions | Civitai" />
      <Container pb="xl">
        <Stack spacing="md">
          <Group position="apart">
            <Title style={{ position: 'relative' }}>
              Questions{' '}
              <Badge color="yellow" size="xs" style={{ position: 'absolute', top: 5, right: -45 }}>
                Beta
              </Badge>
            </Title>
            {!isMuted && (
              <Link href="/questions/create" passHref>
                <Button component="a">Ask question</Button>
              </Link>
            )}
          </Group>
          <Alert>
            <Text>
              Have a question about stable diffusion, fine tuning models, or just how best to
              utilize a prompt? Ask it here! Clever people in the community can help you get the
              most out of your creations! Lost?{' '}
              <Text variant="link" style={{ cursor: 'pointer' }} onClick={openModal} span>
                {`Here's how this works...`}
              </Text>
            </Text>
          </Alert>
          <Questions>
            <Group position="apart">
              <Questions.Sort />
              <Group spacing="xs">
                <Questions.Period />
                <Questions.Filter />
              </Group>
            </Group>
            <Questions.List />
          </Questions>
        </Stack>
      </Container>
    </>
  );
}
