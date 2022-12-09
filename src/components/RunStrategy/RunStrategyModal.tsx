import {
  Table,
  Group,
  Badge,
  Box,
  Loader,
  Alert,
  Stack,
  Text,
  ActionIcon,
  useMantineTheme,
  BadgeProps,
  Tooltip,
  TooltipProps,
  Popover,
  createStyles,
  ScrollArea,
  Center,
  Title,
  CenterProps,
  Button,
} from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';
import {
  IconArrowBigRight,
  IconArrowRight,
  IconInfoCircle,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
} from '@tabler/icons';
import { trpc } from '~/utils/trpc';
import { QS } from '~/utils/qs';
import { useState } from 'react';
import Link from 'next/link';

export default function RunStrategyModal({
  context,
  id,
  innerProps,
}: ContextModalProps<{ modelVersionId: number }>) {
  const theme = useMantineTheme();
  const { modelVersionId } = innerProps;

  const { data: strategies = [], isLoading: strategiesLoading } =
    trpc.modelVersion.getRunStrategies.useQuery({ id: modelVersionId });
  const { data: partners, isLoading: partnersLoading } = trpc.partner.getAll.useQuery();

  // add strategies to partners
  const partnersWithStrategies = partners
    ?.map((partner) => ({
      ...partner,
      strategies: strategies.filter((strategy) => strategy.partnerId === partner.id),
    }))
    .map((partner) => ({ ...partner, enabled: partner.onDemand || partner.strategies.length > 0 }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled));

  const defaultBadgeProps: BadgeProps = {
    variant: 'outline',
    radius: 'sm',
    color: theme.colorScheme === 'dark' ? 'gray' : 'dark',
    styles: {
      root: { textTransform: 'none', userSelect: 'none' },
    },
  };

  const defaultTooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
    withArrow: true,
    openDelay: 500,
  };

  return (
    <Stack>
      <Text>
        Want to try out this model right away? Use one of these services to start generating right
        away.
      </Text>
      {partnersLoading || strategiesLoading ? (
        <Box p="md">
          <Loader />
        </Box>
      ) : !!partnersWithStrategies?.length ? (
        <ScrollArea.Autosize maxHeight={500}>
          <Table striped verticalSpacing={0} horizontalSpacing={0}>
            <tbody>
              {
                // [
                //   ...partnersWithStrategies,
                //   ...partnersWithStrategies,
                //   ...partnersWithStrategies,
                //   ...partnersWithStrategies,
                //   ...partnersWithStrategies,
                //   ...partnersWithStrategies,
                //   ...partnersWithStrategies,
                // ]
                //   .map((partner, index) => ({
                //     ...partner,
                //     enabled: index % 2 === 0,
                //     name: `${partner.name} ${index}`,
                //   }))
                //   .sort((a, b) => Number(b.enabled) - Number(a.enabled))
                partnersWithStrategies.map(
                  (
                    { id, name, about, startupTime, stepsPerSecond, price, strategies, enabled },
                    index
                  ) => (
                    <tr key={index} style={{ opacity: !enabled ? 1 : undefined }}>
                      <td>
                        <Group position="apart" p="sm">
                          <Group spacing="xs">
                            <Text>{name}</Text>
                            <Popover width={500} withinPortal withArrow position="right">
                              <Popover.Target>
                                <Center style={{ cursor: 'pointer' }}>
                                  <IconInfoCircle size={20} />
                                </Center>
                              </Popover.Target>
                              <Popover.Dropdown>
                                <Text>{about}</Text>
                              </Popover.Dropdown>
                            </Popover>
                          </Group>
                          <Group spacing="xs" position="apart">
                            <Group spacing="xs" noWrap>
                              {startupTime && (
                                <Tooltip {...defaultTooltipProps} label="Startup time">
                                  <Badge
                                    {...defaultBadgeProps}
                                    leftSection={<IconRefresh size={14} />}
                                  >
                                    {abbreviateTime(startupTime)}
                                  </Badge>
                                </Tooltip>
                              )}
                              {stepsPerSecond && (
                                <Tooltip {...defaultTooltipProps} label="Image generation time">
                                  <Badge
                                    {...defaultBadgeProps}
                                    leftSection={<IconPhoto size={14} />}
                                  >
                                    {abbreviateTime(calculateStepsPerSecond(stepsPerSecond))}
                                  </Badge>
                                </Tooltip>
                              )}
                              {price && (
                                <Tooltip {...defaultTooltipProps} label="Price">
                                  <Badge {...defaultBadgeProps}>{price}</Badge>
                                </Tooltip>
                              )}
                            </Group>
                            <Button
                              color="blue"
                              compact
                              size="xs"
                              px="md"
                              component="a"
                              href={`/api/run/${modelVersionId}?${QS.stringify({
                                partnerId: id,
                                strategyId: strategies[0]?.id,
                              })}`}
                              target="_blank"
                              rel="noreferrer"
                              disabled={!enabled}
                            >
                              <IconArrowBigRight size={20} />
                            </Button>
                          </Group>
                        </Group>
                      </td>
                    </tr>
                  )
                )
              }
            </tbody>
          </Table>
        </ScrollArea.Autosize>
      ) : (
        <Alert color="yellow">
          Currently, there are no model generating services for this model
        </Alert>
      )}
      <Group spacing={4}>
        <Text size="sm">{"Don't see your preferred service?"}</Text>
        <Text
          size="sm"
          variant="link"
          component={'a'}
          href="https://docs.google.com/forms/d/e/1FAIpQLSdlDQXJMIhgnOjmpgEqfesPThDpxskQNau2HtxPXoLSqDMbwA/viewform"
        >
          Request that they be added
        </Text>
      </Group>
    </Stack>
  );
}

const abbreviateTime = (value: number) => {
  if (value < 60) return `${value}s`;
  else return `${Math.round(value / 60)}m`;
};

const calculateStepsPerSecond = (value: number) => {
  const parsed = 30 / value;
  if (parsed < 1) return Math.round(parsed * 10) / 10;

  return Math.round(parsed);
};
