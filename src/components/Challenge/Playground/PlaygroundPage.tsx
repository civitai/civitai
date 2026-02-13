import { Card, Center, Flex, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NotFound } from '~/components/AppLayout/NotFound';
import { JudgeListPanel } from './JudgeListPanel';
import { ActivityPanel } from './ActivityPanel';
import { JudgeSettingsPanel } from './JudgeSettingsPanel';

export function PlaygroundPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  if (!features.challengePlatform) {
    return <NotFound />;
  }

  if (!currentUser?.isModerator) {
    return (
      <Center py="xl">
        <Text>Access denied. You do not have permission to access this page.</Text>
      </Center>
    );
  }

  return (
    <Flex h="calc(100vh - 60px)" gap={0}>
      {/* Left panel: Judge list */}
      <Card withBorder radius={0} p={0} style={{ width: 250, minWidth: 250, borderRight: 0 }}>
        <JudgeListPanel />
      </Card>

      {/* Center panel: Activity */}
      <Card withBorder radius={0} p={0} style={{ flex: 1, minWidth: 0 }}>
        <ActivityPanel />
      </Card>

      {/* Right panel: Judge settings */}
      <Card withBorder radius={0} p={0} style={{ width: 350, minWidth: 350, borderLeft: 0 }}>
        <JudgeSettingsPanel />
      </Card>
    </Flex>
  );
}
