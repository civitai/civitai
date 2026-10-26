import { Container, Stack, Text, Title } from '@mantine/core';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { AppAccessRequestsQueue } from '~/components/Moderation/AppAccessRequests/AppAccessRequestsQueue';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

function AppAccessRequestsPage() {
  return (
    <>
      <Meta title="App Access Requests" deIndex />
      <Container size="xl" py="lg">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>App Access Requests</Title>
            <Text c="dimmed" size="sm">
              Requests sent from the Request access button on /apps/build.
            </Text>
          </Stack>
          <AppAccessRequestsQueue />
        </Stack>
      </Container>
    </>
  );
}

export default Page(AppAccessRequestsPage);
