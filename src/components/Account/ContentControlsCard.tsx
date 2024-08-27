import { Card, Stack } from '@mantine/core';
import { AdContent } from '~/components/Account/AdContent';
import { ContentControls } from '~/components/Account/ContentControls';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ContentControlsCard() {
  const currentUser = useCurrentUser();
  return (
    <Card withBorder id="content-controls">
      <Stack>
        <ContentControls />
        <HiddenTagsSection />
        <HiddenUsersSection />
        {currentUser?.isMember && <AdContent />}
      </Stack>
    </Card>
  );
}
