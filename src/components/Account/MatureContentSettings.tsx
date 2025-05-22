import { Text, Stack } from '@mantine/core';
import { BrowsingLevelsStacked } from '~/components/BrowsingLevel/BrowsingLevelsStacked';
import { ToggleList } from '~/components/ToggleList/ToggleList';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';

export function MatureContentSettings() {
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const setState = useBrowsingSettings((x) => x.setState);

  const toggleBlurNsfw = () => setState((state) => ({ blurNsfw: !state.blurNsfw }));
  const toggleShowNsfw = () => setState((state) => ({ showNsfw: !state.showNsfw }));

  return (
    <Stack>
      <ToggleList>
        <ToggleList.Item checked={showNsfw} onChange={() => toggleShowNsfw()}>
          <div>
            <Text fw={500}>Show mature content</Text>
            <Text size="sm">
              {`By enabling mature content, you confirm you are over the age of 18.`}
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
          <Stack gap={0}>
            <Text fw={500}>Browsing Levels</Text>
            {/* <Text size="sm">Pick browsing levels for the type of content you want to see.</Text> */}
          </Stack>
          <BrowsingLevelsStacked />
        </Stack>
      )}
    </Stack>
  );
}
