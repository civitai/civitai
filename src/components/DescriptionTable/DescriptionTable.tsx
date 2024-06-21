import { Box, Group, Paper, PaperProps, Table, TableProps, Text } from '@mantine/core';
import React from 'react';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';

export function DescriptionTable({
  items,
  title,
  labelWidth,
  withBorder = true,
  paperProps,
  ...props
}: Props) {
  const rows = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.visible === false) continue;

    let labelEl =
      typeof item.label === 'string' ? <Text weight="500">{item.label}</Text> : item.label;
    if (item.info) {
      labelEl = (
        <Group spacing={4}>
          {labelEl}
          <InfoPopover size="xs" withArrow iconProps={{ size: 16 }}>
            {item.info}
          </InfoPopover>
        </Group>
      );
    }

    rows.push(
      <Box component="tr" key={i}>
        <Box
          component="td"
          sx={(theme) => ({
            backgroundColor:
              theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
            width: labelWidth,
            padding: '7px 7px !important',
          })}
        >
          {labelEl}
        </Box>
        <Box component="td" sx={{ padding: '7px 7px !important' }}>
          {item.value}
        </Box>
      </Box>
    );
  }

  return (
    <Paper radius="sm" {...paperProps} withBorder={withBorder}>
      {title && typeof title === 'string' ? (
        <Text size="md" weight="500" p="xs">
          {title}
        </Text>
      ) : (
        title
      )}
      <Table
        withColumnBorders
        {...props}
        sx={(theme) => ({
          borderTop: title
            ? `1px ${
                theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
              } solid`
            : undefined,
        })}
      >
        <Box component="tbody">{rows}</Box>
      </Table>
    </Paper>
  );
}

export type Props = TableProps & {
  items: Array<{
    label: React.ReactNode;
    value: React.ReactNode;
    visible?: boolean;
    info?: React.ReactNode;
  }>;
  title?: React.ReactNode;
  labelWidth?: React.CSSProperties['width'];
  withBorder?: boolean;
  paperProps?: PaperProps;
};
