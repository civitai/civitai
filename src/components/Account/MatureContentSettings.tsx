import { Group, Switch, Text, Stack, Title } from '@mantine/core';
import { useBrowsingModeContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelsStacked } from '~/components/BrowsingLevel/BrowsingLevelsStacked';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function MatureContentSettings() {
  const currentUser = useCurrentUser();
  const { toggleBlurNsfw, toggleShowNsfw } = useBrowsingModeContext();
  const showNsfw = currentUser?.showNsfw;
  const blurNsfw = currentUser?.blurNsfw;

  return (
    <Stack>
      <Group position="apart" noWrap>
        <div>
          <Text weight={500}>Show mature content</Text>
          <Text size="sm">
            {`By enabling Mature Content, you confirm you are over the age of 18.`}
          </Text>
        </div>
        <Switch checked={showNsfw} onChange={(e) => toggleShowNsfw(e.target.checked)} />
      </Group>
      <Group position="apart" noWrap>
        <Text color={!showNsfw ? 'dimmed' : undefined}>
          <Text weight={500}>Blur mature content</Text>
          <Text size="sm">Blur images and videos that are marked as mature</Text>
        </Text>
        <Switch
          disabled={!showNsfw}
          checked={showNsfw && blurNsfw}
          onChange={(e) => toggleBlurNsfw(e.target.checked)}
        />
      </Group>
      {showNsfw && (
        <Stack spacing="xs">
          <Stack spacing={0}>
            <Title order={2}>Browsing levels</Title>
            <Text size="sm">
              Pick browsing levels for the type of content you want to see. If no levels are
              selected, we will serve you content based off system defaults.
            </Text>
          </Stack>
          <BrowsingLevelsStacked />
        </Stack>
      )}
    </Stack>
  );
}
