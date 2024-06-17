import { Card, Stack } from '@mantine/core';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';

export function ContentControlsCard() {
  return (
    <Card withBorder id="content-controls">
      <Stack>
        <HiddenTagsSection />
        <HiddenUsersSection />
        <MatureContentSettings />
      </Stack>
    </Card>
  );
}
