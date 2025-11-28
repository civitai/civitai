import type { MantineColor } from '@mantine/core';
import { Group, Loader, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconTemperature } from '@tabler/icons-react';
import { useModelVersionTopicListener } from '~/components/Model/ModelVersions/model-version.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getImageGenConfigKey } from '~/shared/orchestrator/ImageGen/imageGen.config';
import { trpc } from '~/utils/trpc';

// const featureInfo = {
//   name: 'Featured',
//   description: 'Featured by the community',
//   markup: -0.2,
// } as const;
// const newInfo = {
//   name: 'New',
//   description: 'Newly available for generation',
//   markup: 0.2,
// };
const popularityInfoMap = {
  '0.0': {
    name: 'Dormant',
    description: 'Not currently being used for generation',
    markup: 0.4,
  },
  '0.1': {
    name: 'Quiet',
    description: 'Very low generation engagement',
    markup: 0.3,
  },
  '0.2': {
    name: 'Underground Hit',
    description: 'Some generation activity, but not frequent',
    markup: 0.2,
  },
  '0.3': {
    name: 'Getting Hype',
    description: 'Consistently generated with at a moderate level',
    markup: 0.1,
  },
  '0.4': {
    name: 'Taking Off',
    description: 'Frequently generated with',
    markup: 0.0,
  },
  '0.6': {
    name: 'Crushing It',
    description: 'Strong generation usage',
    markup: -0.1,
  },
  '0.8': {
    name: 'Buzzing!',
    description: 'Extremely high generation usage',
    markup: -0.2,
  },
} as const;

export const ModelVersionPopularity = ({
  versionId,
  isCheckpoint,
  listenForUpdates,
}: {
  versionId: number;
  isCheckpoint: boolean;
  listenForUpdates: boolean;
}) => {
  const theme = useMantineTheme(); // TODO improve colors
  const features = useFeatureFlags();
  useModelVersionTopicListener(listenForUpdates ? versionId : undefined);

  const { data, isLoading } = trpc.modelVersion.getPopularity.useQuery(
    { id: versionId },
    { enabled: features.modelVersionPopularity }
  );

  const configKey = getImageGenConfigKey(versionId);
  if (configKey && configKey !== 'flux2' && configKey !== 'qwen') return <></>;

  if (!features.modelVersionPopularity) return <></>;
  // if we want to show this for non checkpoints, simply remove this line
  if (!isCheckpoint) return <></>;
  if (isLoading) return <Loader size="xs" type="bars" />;

  const popColors: {
    [key in
      | (typeof popularityInfoMap)[keyof typeof popularityInfoMap]['name']
      | 'Featured']: MantineColor;
  } = {
    Dormant: theme.colors.red[7],
    Quiet: theme.colors.orange[8],
    'Underground Hit': theme.colors.orange[5],
    'Getting Hype': theme.colors.yellow[5],
    'Taking Off': theme.colors.lime[6],
    'Crushing It': theme.colors.lime[9],
    'Buzzing!': theme.colors.green[7],
    Featured: theme.colors.teal[7],
  };

  const popularity = data?.popularityRank ?? 0;
  // const isFeatured = data?.isFeatured ?? false;
  // const isNew = data?.isNew ?? false; // TODO check for isNew

  const closestPopularityKey =
    ((Object.keys(popularityInfoMap) as Array<keyof typeof popularityInfoMap>)
      .map(Number)
      .filter((key) => key <= popularity)
      .sort((a, b) => b - a)[0]
      ?.toFixed(1) as keyof typeof popularityInfoMap) ?? '0.0';
  // const closestPopularityInfo = isFeatured ? featureInfo : popularityInfoMap[closestPopularityKey];
  const closestPopularityInfo = popularityInfoMap[closestPopularityKey];

  return (
    <Tooltip multiline withinPortal label={<Text>{closestPopularityInfo.description}</Text>}>
      <Group
        gap={4}
        style={{
          color: popColors[closestPopularityInfo.name],
        }}
        wrap="nowrap"
        className="cursor-default"
      >
        <IconTemperature size={16} />
        <Text size="xs">{closestPopularityInfo.name}</Text>
      </Group>
    </Tooltip>
  );
};