import { Card, Group, Stack, Title, Text } from '@mantine/core';
import React from 'react';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';

export function ModerationCard() {
  return (
    <Card withBorder id="content-moderation">
      <Stack>
        <Title order={3}>Content Moderation</Title>
        <MatureContentSettings />
      </Stack>
    </Card>
  );
}
