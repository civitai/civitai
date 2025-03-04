import { Badge, Group, Loader, Stack, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconTemperature } from '@tabler/icons-react';
import { useModelVersionTopicListener } from '~/components/Model/ModelVersions/model-version.utils';
import { trpc } from '~/utils/trpc';

const featureInfo = {
  name: 'Featured',
  description: 'Featured by the community',
  markup: -0.2,
} as const;
const popularityInfoMap = {
  '0.0': {
    name: 'Inactive',
    description: 'Not being used',
    markup: 0.4,
  },
  '0.1': {
    name: 'Minimal Use',
    description: 'Very low engagement',
    markup: 0.3,
  },
  '0.2': {
    name: 'Low Use',
    description: 'Some activity, but not frequent',
    markup: 0.2,
  },
  '0.3': {
    name: 'Steady Use',
    description: 'Consistently used at a moderate level',
    markup: 0.1,
  },
  '0.4': {
    name: 'High Use',
    description: 'Frequently used, growing demand',
    markup: 0.0,
  },
  '0.6': {
    name: 'Heavy Use',
    description: 'Strong demand, many users',
    markup: -0.1,
  },
  '0.8': {
    name: 'Max Use',
    description: 'Extremely high usage, peak demand',
    markup: -0.2,
  },
} as const;

export const ModelVersionPopularity = ({
  versionId,
  listenForUpdates,
}: {
  versionId: number;
  listenForUpdates: boolean;
}) => {
  const theme = useMantineTheme();
  useModelVersionTopicListener(listenForUpdates ? versionId : undefined);

  const { data, isLoading } = trpc.modelVersion.getPopularity.useQuery({ id: versionId });

  const popularity = data?.popularityRank ?? 0;
  const isFeatured = data?.isFeatured ?? false;

  const isDark = theme.colorScheme === 'dark';

  const closestPopularityKey =
    ((Object.keys(popularityInfoMap) as Array<keyof typeof popularityInfoMap>)
      .map(Number)
      .filter((key) => key <= popularity)
      .sort((a, b) => b - a)[0]
      ?.toFixed(1) as keyof typeof popularityInfoMap) ?? '0.0';
  const closestPopularityInfo = isFeatured ? featureInfo : popularityInfoMap[closestPopularityKey];

  const markup = Math.trunc(closestPopularityInfo.markup * 100);
  const isMarkup = markup >= 0;

  if (isLoading) return <Loader size="xs" variant="bars" />;

  return (
    <Tooltip
      multiline
      withinPortal
      label={
        <Stack spacing={4}>
          <Text>{closestPopularityInfo.description}</Text>
          <Group spacing="sm">
            <Badge
              color={isMarkup ? (isDark ? 'red.1' : 'red.9') : isDark ? 'green.1' : 'green.9'}
              size="xs"
            >
              {isMarkup ? 'Markup' : 'Discount'}
            </Badge>
            <Text>{Math.abs(markup)}%</Text>
          </Group>
        </Stack>
      }
    >
      <Group
        spacing={4}
        style={{
          color: isFeatured
            ? theme.colors.green[7]
            : `rgb(${Math.round(255 * (1 - popularity))}, ${Math.round(255 * popularity)}, 0)`,
        }}
        noWrap
        className="cursor-default"
      >
        <IconTemperature size={16} />
        <Text size="xs">{closestPopularityInfo.name}</Text>
      </Group>
    </Tooltip>
  );
};
