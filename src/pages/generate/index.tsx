import { Center, Container, Grid, Stack, Tabs, Text, ThemeIcon } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { Feed } from '~/components/ImageGeneration/Feed';
import { GenerateFormLogic } from '~/components/ImageGeneration/GenerationForm/GenerateFormLogic';
import { Queue } from '~/components/ImageGeneration/Queue';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { IsClient } from '~/components/IsClient/IsClient';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.req.url }),
          permanent: false,
        },
      };

    if (!features?.imageGeneration) return { notFound: true };
  },
});

export default function GeneratePage() {
  const currentUser = useCurrentUser();

  const result = useGetGenerationRequests({});

  if (currentUser?.muted)
    return (
      <Center h="100%" w="75%" mx="auto">
        <Stack spacing="xl" align="center">
          <ThemeIcon size="xl" radius="xl" color="yellow">
            <IconLock />
          </ThemeIcon>
          <Text align="center">You cannot create new generations because you have been muted</Text>
        </Stack>
      </Center>
    );

  return (
    <Container size="lg">
      <Grid gutter={48}>
        <Grid.Col span={5} maw={400}>
          <IsClient>
            <GenerateFormLogic />
          </IsClient>
        </Grid.Col>
        <Grid.Col span={7} sx={{ maxWidth: 'unset', flexGrow: 1 }}>
          <Tabs variant="pills" defaultValue="queue" radius="xl" color="gray">
            <Tabs.List>
              <Tabs.Tab value="queue">Queue</Tabs.Tab>
              <Tabs.Tab value="feed">Feed</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="queue">
              <Queue {...result} />
            </Tabs.Panel>
            <Tabs.Panel value="feed">
              <Feed {...result} />
            </Tabs.Panel>
          </Tabs>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
