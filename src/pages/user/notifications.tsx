import { Container } from '@mantine/core';

import { Meta } from '~/components/Meta/Meta';

import { NotificationsComposed } from '~/components/Notifications/NotificationsComposed';

export default function Notifications() {
  return (
    <>
      <Meta title="Notifications | Civitai" deIndex />
      <Container size="sm">
        <NotificationsComposed />
      </Container>
    </>
  );
}
