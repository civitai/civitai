import { Container, Stack, Title, Group, Button, Badge, Alert, Text } from '@mantine/core';
import Link from 'next/link';

import { Meta } from '~/components/Meta/Meta';
import { Questions } from '~/components/Questions/Questions.Provider';
import { openContextModal } from '@mantine/modals';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '~/env/client.mjs';

// export const getServerSideProps = createServerSideProps({
//   useSSG: true,
//   resolver: async ({ ssg, ctx }) => {
//     const page = ctx.query.page ? Number(ctx.query.page) : 1;
//     const {
//       sort = constants.questionFilterDefaults.sort,
//       period = constants.questionFilterDefaults.period,
//       status,
//     } = parseCookies(ctx.req.cookies).questions;

//     await ssg?.question.getPaged.prefetch({
//       page,
//       limit: constants.questionFilterDefaults.limit,
//       sort,
//       period,
//       status,
//     });
//   },
// });

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
      <Meta
        title="Civitai Questions | Ask the Generative AI Community"
        description="Got questions about Stable Diffusion, fine-tuning, or prompting? Dive into our community forum and ask generative AI experts for guidance"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/questions`, rel: 'canonical' }]}
      />
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
              <Link href="/questions/create">
                <Button>Ask question</Button>
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
