import { Table, Group, Badge, Box, Loader, Alert, Stack, Text, ActionIcon } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';
import { IconPhoto, IconPlayerPlay, IconRefresh } from '@tabler/icons';
import { trpc } from '~/utils/trpc';
import { QS } from '~/utils/qs';

export default function RunStrategyModal({
  context,
  id,
  innerProps,
}: ContextModalProps<{ modelVersionId: number }>) {
  const { modelVersionId } = innerProps;

  const { data: strategies = [], isLoading: strategiesLoading } =
    trpc.modelVersion.getRunStrategies.useQuery({ id: modelVersionId });
  const { data: partners, isLoading: partnersLoading } = trpc.partner.getAll.useQuery();

  // add strategies to partners and filter out unavailable partners
  const partnersWithStrategies = partners
    ?.map((partner) => ({
      ...partner,
      strategies: strategies.filter((strategy) => strategy.partnerId === partner.id),
    }))
    .filter((partner) => partner.onDemand || partner.strategies.length > 0);

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
      ) : partnersWithStrategies ? (
        <Table striped>
          <tbody>
            {partnersWithStrategies?.map(
              ({ id, name, startupTime, stepsPerSecond, pricingModel }) => (
                <tr key={id}>
                  <Group position="apart" noWrap>
                    {name}
                    <Group spacing="xs">
                      {startupTime && (
                        <Badge leftSection={<IconRefresh size={16} />}>{startupTime}</Badge>
                      )}
                      {stepsPerSecond && (
                        <Badge leftSection={<IconPhoto />}>{stepsPerSecond / 30}</Badge>
                      )}
                      {pricingModel && <Badge>{pricingModel}</Badge>}
                      <ActionIcon
                        variant="filled"
                        component="a"
                        href={`/api/run/${modelVersionId}?${QS.stringify({})}`}
                        target="_blank"
                      >
                        <IconPlayerPlay />
                      </ActionIcon>
                    </Group>
                  </Group>
                </tr>
              )
            )}
          </tbody>
        </Table>
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
