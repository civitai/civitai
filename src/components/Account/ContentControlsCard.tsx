import { Card, Stack } from '@mantine/core';
import { AdContent } from '~/components/Account/AdContent';
import { ContentControls } from '~/components/Account/ContentControls';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';

export function ContentControlsCard() {
  return (
    <Card withBorder id="content-controls">
      <Stack>
        <ContentControls />
        <HiddenTagsSection />
        <HiddenUsersSection />
        <AdContent />
      </Stack>
    </Card>
  );
}
