import { Card, Center, Flex, Tabs, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NotFound } from '~/components/AppLayout/NotFound';
import { JudgeListPanel } from './JudgeListPanel';
import { ActivityPanel } from './ActivityPanel';
import { JudgeSettingsPanel } from './JudgeSettingsPanel';
import { CategoriesPanel } from './CategoriesPanel';

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
    <Tabs defaultValue="judges" keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="judges">Judges</Tabs.Tab>
        <Tabs.Tab value="categories">Categories</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="judges">
        <Flex
          h="calc(100vh - var(--header-height) - var(--footer-height) - 110px)"
          gap={0}
          style={{ overflow: 'hidden' }}
        >
          {/* Left panel: Judge list */}
          <Card
            withBorder
            radius={0}
            p={0}
            h="100%"
            style={{ width: 250, minWidth: 250, borderRight: 0, overflow: 'hidden' }}
          >
            <JudgeListPanel />
          </Card>

          {/* Center panel: Activity */}
          <Card
            withBorder
            radius={0}
            p={0}
            h="100%"
            style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
          >
            <ActivityPanel />
          </Card>

          {/* Right panel: Judge settings */}
          <Card
            withBorder
            radius={0}
            p={0}
            h="100%"
            style={{ width: 350, minWidth: 350, borderLeft: 0, overflow: 'hidden' }}
          >
            <JudgeSettingsPanel />
          </Card>
        </Flex>
      </Tabs.Panel>

      <Tabs.Panel value="categories">
        <CategoriesPanel />
      </Tabs.Panel>
    </Tabs>
  );
}
