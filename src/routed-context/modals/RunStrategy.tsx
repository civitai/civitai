import {
  Badge,
  BadgeProps,
  Button,
  Center,
  Group,
  Modal,
  Popover,
  Stack,
  Table,
  Tooltip,
  TooltipProps,
  useMantineTheme,
  Text,
  Alert,
  Divider,
  Loader,
  ScrollArea,
} from '@mantine/core';
import { IconInfoCircle, IconRefresh, IconPhoto, IconArrowBigRight, IconBan } from '@tabler/icons';
import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  schema: z.object({ modelVersionId: z.number() }),
  Element: ({ context, props: { modelVersionId } }) => {
    const theme = useMantineTheme();

    const { data: strategies = [], isLoading: strategiesLoading } =
      trpc.modelVersion.getRunStrategies.useQuery({ id: modelVersionId });
    const { data: partners, isLoading: partnersLoading } = trpc.partner.getAll.useQuery();

    // add strategies to partners
    const partnersWithStrategies =
      partners
        ?.map((partner) => ({
          ...partner,
          strategies: strategies.filter((strategy) => strategy.partnerId === partner.id),
        }))
        .map((partner) => ({
          ...partner,
          available: partner.strategies.length > 0,
        }))
        .sort((a, b) => Number(b.available) - Number(a.available)) ?? [];

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

    const availablePartners = partnersWithStrategies.filter((x) => x.available);
    const unavailablePartners = partnersWithStrategies.filter((x) => !x.available);

    const renderPartners = (
      partners: typeof partnersWithStrategies,
      extra: React.ReactNode = null
    ) => {
      return (
        <Table striped verticalSpacing={0} horizontalSpacing={0}>
          <tbody>
            {partners.map(
              (
                {
                  id,
                  name,
                  about,
                  startupTime,
                  stepsPerSecond,
                  price,
                  strategies,
                  available: enabled,
                  homepage,
                  tos,
                  privacy,
                },
                index
              ) => (
                <tr key={index} style={{ opacity: !enabled ? 1 : undefined }}>
                  <td>
                    <Group position="apart" p="sm">
                      <Group spacing="xs">
                        <Text>{name}</Text>
                        <Popover width={400} withinPortal withArrow position="right">
                          <Popover.Target>
                            <Center style={{ cursor: 'pointer' }}>
                              <IconInfoCircle size={20} />
                            </Center>
                          </Popover.Target>
                          <Popover.Dropdown>
                            <Stack>
                              <Text>{about}</Text>
                              <Group spacing="xs">
                                {homepage && (
                                  <Button
                                    compact
                                    variant="light"
                                    component="a"
                                    href={homepage}
                                    target="_blank"
                                  >
                                    Website
                                  </Button>
                                )}
                                {tos && (
                                  <Button
                                    compact
                                    variant="light"
                                    component="a"
                                    href={tos}
                                    target="_blank"
                                  >
                                    Terms of Service
                                  </Button>
                                )}
                                {privacy && (
                                  <Button
                                    compact
                                    variant="light"
                                    component="a"
                                    href={privacy}
                                    target="_blank"
                                  >
                                    Privacy
                                  </Button>
                                )}
                              </Group>
                            </Stack>
                          </Popover.Dropdown>
                        </Popover>
                      </Group>
                      <Group spacing="xs" position="apart">
                        <Group spacing="xs" noWrap>
                          {startupTime && (
                            <Tooltip {...defaultTooltipProps} label="Startup time">
                              <Badge {...defaultBadgeProps} leftSection={<IconRefresh size={14} />}>
                                {abbreviateTime(startupTime)}
                              </Badge>
                            </Tooltip>
                          )}
                          {stepsPerSecond && (
                            <Tooltip {...defaultTooltipProps} label="Image generation time">
                              <Badge {...defaultBadgeProps} leftSection={<IconPhoto size={14} />}>
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
                        {enabled && (
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
                          >
                            <IconArrowBigRight size={20} />
                          </Button>
                        )}
                      </Group>
                    </Group>
                  </td>
                </tr>
              )
            )}
            {extra}
          </tbody>
        </Table>
      );
    };

    return (
      <Modal
        opened={context.opened}
        onClose={context.close}
        size={600}
        title={<Text weight={700}>Generate images using this model now</Text>}
      >
        <Stack>
          <Text>
            Want to try out this model right away? Use one of these services to start generating
            right away.
          </Text>
          {partnersLoading || strategiesLoading ? (
            <Center p="md">
              <Loader />
            </Center>
          ) : !!partnersWithStrategies?.length ? (
            <ScrollArea.Autosize maxHeight={500}>
              <Stack>
                {renderPartners(
                  availablePartners,
                  <tr>
                    <td>
                      <Group position="apart" p="sm">
                        <Group spacing="xs">
                          <Text>Automatic 1111 Web UI (Local)</Text>
                        </Group>
                        <Group spacing="xs" position="apart">
                          <Group spacing="xs" noWrap>
                            <Badge {...defaultBadgeProps}>Coming Soon</Badge>
                            <Badge {...defaultBadgeProps} color="yellow">
                              Help Wanted
                            </Badge>
                          </Group>
                          <Button
                            color="blue"
                            compact
                            size="xs"
                            px="md"
                            component="a"
                            href={`https://github.com/civitai/sd_civitai_extension`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <IconArrowBigRight size={20} />
                          </Button>
                        </Group>
                      </Group>
                    </td>
                  </tr>
                )}
                {unavailablePartners.length > 0 && (
                  <>
                    <Divider
                      variant="dashed"
                      labelPosition="center"
                      label={
                        <Group spacing={4}>
                          <IconBan size={14} />
                          <Text>Not available</Text>
                        </Group>
                      }
                    />
                    {renderPartners(unavailablePartners)}
                  </>
                )}
              </Stack>
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
      </Modal>
    );
  },
});

const abbreviateTime = (value: number) => {
  if (value < 60) return `${value}s`;
  else return `${Math.round(value / 60)}m`;
};

const calculateStepsPerSecond = (value: number) => {
  const parsed = 30 / value;
  if (parsed < 1) return Math.round(parsed * 10) / 10;

  return Math.round(parsed);
};
