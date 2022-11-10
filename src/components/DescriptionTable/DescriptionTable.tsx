import { Box, Paper, Table, TableProps, Text } from '@mantine/core';
import React from 'react';

export function DescriptionTable({ items, title, labelWidth, ...props }: Props) {
  const rows = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.visible === false) continue;

    rows.push(
      <Box component="tr" key={i}>
        <Box
          component="td"
          sx={(theme) => ({
            backgroundColor:
              theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
            width: labelWidth,
          })}
        >
          {typeof item.label === 'string' ? <Text weight="500">{item.label}</Text> : item.label}
        </Box>
        <Box component="td">{item.value}</Box>
      </Box>
    );
  }

  return (
    <Paper radius="sm" withBorder>
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
  items: Array<{ label: React.ReactNode; value: React.ReactNode; visible?: boolean }>;
  title?: React.ReactNode;
  labelWidth?: React.CSSProperties['width'];
};
