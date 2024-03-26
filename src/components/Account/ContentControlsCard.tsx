import { Card, Stack } from '@mantine/core';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';

export function ContentControlsCard() {
  return (
    <Card withBorder id="content-controls">
      <Stack>
        <HiddenTagsSection />
        <HiddenUsersSection />
      </Stack>
    </Card>
  );
}
