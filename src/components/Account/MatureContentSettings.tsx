import { Group, Skeleton, Switch, SwitchProps, Text, Stack, Title } from '@mantine/core';
import {
  useBrowsingModeContext,
  useShowNsfw,
  useBlurNsfw,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelsStacked } from '~/components/BrowsingLevel/BrowsingLevelsStacked';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function MatureContentSettings() {
  const currentUser = useCurrentUser();
  const { toggleBlurNsfw, toggleShowNsfw } = useBrowsingModeContext();
  const showNsfw = useShowNsfw();
  const blurNsfw = useBlurNsfw();

  return (
    <Stack>
      <Group position="apart" noWrap>
        <div>
          <Text weight={500}>Show mature content</Text>
          <Text size="sm">
            {`By enabling Mature Content, you confirm you are over the age of 18.`}
          </Text>
        </div>
        <SkeletonSwitch
          loading={!currentUser}
          checked={showNsfw}
          onChange={(e) => toggleShowNsfw(e.target.checked)}
        />
      </Group>
      <Group position="apart" noWrap>
        <Text color={!showNsfw ? 'dimmed' : undefined}>
          <Text weight={500}>Blur mature content</Text>
          <Text size="sm">Blur images and videos that are marked as mature</Text>
        </Text>
        <SkeletonSwitch
          disabled={!showNsfw}
          loading={!currentUser}
          checked={showNsfw && blurNsfw}
          onChange={(e) => toggleBlurNsfw(e.target.checked)}
        />
      </Group>
      {showNsfw && (
        <Stack spacing="xs">
          <Stack spacing={0}>
            <Title order={2}>Browsing levels</Title>
            <Text size="sm">
              Pick browsing browsing levels for the type of content you want to see. If no levels
              are selected, we will serve you content based off system defaults.
            </Text>
          </Stack>
          <BrowsingLevelsStacked />
        </Stack>
      )}
    </Stack>
  );
}

const SkeletonSwitch = ({ loading, ...props }: { loading: boolean } & SwitchProps) => {
  return (
    <Skeleton height={20} width={40} radius="lg" visible={loading}>
      <Switch {...props} />
    </Skeleton>
  );
};
