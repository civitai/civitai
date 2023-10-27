import { Divider, Stack, Text } from '@mantine/core';
import { numberWithCommas } from '~/utils/number-helpers';

export function StatTooltip({ value, label }: Props) {
  const valueNode = (
    typeof value === 'string' ? (
      <Text size="xs">{value}</Text>
    ) : typeof value === 'number' || typeof value === 'undefined' ? (
      <Text size="xs">{numberWithCommas(value ?? 0)}</Text>
    ) : (
      value
    )
  ) as React.ReactNode;

  return (
    <Stack spacing={0} align="center" w="100%">
      <Text
        sx={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}
        size="xs"
        color="dimmed"
        mb={4}
        mt={-5}
        mx={-8}
        px={5}
        pb={2}
        weight={500}
      >
        {label}
      </Text>
      {valueNode}
    </Stack>
  );
}

type Props = {
  value?: number | string | React.ReactNode;
  label: React.ReactNode;
};
