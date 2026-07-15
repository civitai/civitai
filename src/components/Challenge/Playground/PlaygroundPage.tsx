import { Card, Center, Flex, Tabs, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NotFound } from '~/components/AppLayout/NotFound';
import { JudgeListPanel } from './JudgeListPanel';
import { ActivityPanel } from './ActivityPanel';
import { JudgeSettingsPanel } from './JudgeSettingsPanel';
import { CategoriesPanel } from './CategoriesPanel';
import { PLAYGROUND_PANEL_HEIGHT } from './playground.constants';

export function PlaygroundPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const router = useRouter();

  const activeTab = router.query.tab === 'categories' ? 'categories' : 'judges';
  const setTab = (value: string | null) => {
    router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: value ?? 'judges' } },
      undefined,
      { shallow: true }
    );
  };

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
    <Tabs value={activeTab} onChange={setTab} keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="judges">Judges</Tabs.Tab>
        <Tabs.Tab value="categories">Categories</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="judges">
        <Flex h={PLAYGROUND_PANEL_HEIGHT} gap={0} style={{ overflow: 'hidden' }}>
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
