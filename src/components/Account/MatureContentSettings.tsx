import { Text, Stack } from '@mantine/core';
import { BrowsingLevelsStacked } from '~/components/BrowsingLevel/BrowsingLevelsStacked';
import { ToggleList } from '~/components/ToggleList/ToggleList';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useUserSettings } from '~/providers/UserSettingsProvider';

export function MatureContentSettings() {
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const blurNsfw = useUserSettings((x) => x.blurNsfw);
  const setBrowsingSettingsState = useBrowsingSettings((x) => x.setState);
  const setUserSettingsState = useUserSettings((x) => x.setState);

  const toggleBlurNsfw = () => setUserSettingsState((state) => ({ blurNsfw: !state.blurNsfw }));
  const toggleShowNsfw = () => setBrowsingSettingsState((state) => ({ showNsfw: !state.showNsfw }));

  return (
    <Stack>
      <ToggleList>
        <ToggleList.Item checked={showNsfw} onChange={() => toggleShowNsfw()}>
          <div>
            <Text fw={500}>Enable mature content</Text>
            <Text size="sm">
              By enabling mature content, you confirm you are over the age of 18 and wish to view
              and/or create such content.
            </Text>
          </div>
        </ToggleList.Item>
        <ToggleList.Item
          checked={showNsfw && blurNsfw}
          onChange={() => toggleBlurNsfw()}
          disabled={!showNsfw}
        >
          <div>
            <Text c={!showNsfw ? 'dimmed' : undefined} fw={500}>
              Blur mature content
            </Text>
            <Text c={!showNsfw ? 'dimmed' : undefined} size="sm">
              Blur images and videos that are marked as mature
            </Text>
          </div>
        </ToggleList.Item>
      </ToggleList>
      {showNsfw && (
        <Stack gap={4}>
          <Text fw={500}>Browsing Levels</Text>
          <BrowsingLevelsStacked />
        </Stack>
      )}
    </Stack>
  );
}
