import { ScrollArea, SegmentedControl, Stack } from '@mantine/core';
import { GenerateContentActivity } from './GenerateContentActivity';
import { ReviewImageActivity } from './ReviewImageActivity';
import { PickWinnersActivity } from './PickWinnersActivity';
import { usePlaygroundStore, type ActivityTab } from './playground.store';

const TABS: Array<{ value: ActivityTab; label: string }> = [
  { value: 'generateContent', label: 'Generate Content' },
  { value: 'reviewImage', label: 'Review Image' },
  { value: 'pickWinners', label: 'Pick Winners' },
];

export function ActivityPanel() {
  const activityTab = usePlaygroundStore((s) => s.activityTab);
  const setActivityTab = usePlaygroundStore((s) => s.setActivityTab);

  return (
    <Stack gap={0} h="100%">
      <div style={{ padding: 'var(--mantine-spacing-sm)' }}>
        <SegmentedControl
          data={TABS}
          value={activityTab}
          onChange={(val) => setActivityTab(val as ActivityTab)}
          fullWidth
        />
      </div>
      <ScrollArea flex={1} px="sm" pb="sm">
        {activityTab === 'generateContent' && <GenerateContentActivity />}
        {activityTab === 'reviewImage' && <ReviewImageActivity />}
        {activityTab === 'pickWinners' && <PickWinnersActivity />}
      </ScrollArea>
    </Stack>
  );
}
