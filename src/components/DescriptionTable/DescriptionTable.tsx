import { Group, Paper, PaperProps, Table, TableProps, Text } from '@mantine/core';
import clsx from 'clsx';
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
        <Group gap={4}>
          {labelEl}
          <InfoPopover size="xs" withArrow iconProps={{ size: 16 }}>
            {item.info}
          </InfoPopover>
        </Group>
      );
    }

    rows.push(
      <Table.Tr key={i} {...item.rowProps}>
        <Table.Td
          className={clsx('bg-gray-0 dark:bg-dark-6', item.className)}
          style={{
            width: labelWidth,
            padding: '7px 7px !important',
          }}
        >
          {labelEl}
        </Table.Td>
        <Table.Td className={item.className} style={{ padding: '7px 7px !important' }}>
          {item.value}
        </Table.Td>
      </Table.Tr>
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
        className={clsx(title && 'border-t-gray-3 dark:border-t-dark-4', props.className)}
      >
        <Table.Tbody>{rows}</Table.Tbody>
      </Table>
    </Paper>
  );
}

export type Props = Omit<TableProps, 'title'> & {
  items: Array<{
    label: React.ReactNode;
    value: React.ReactNode;
    visible?: boolean;
    info?: React.ReactNode;
    className?: string;
    rowProps?: MixedObject;
  }>;
  title?: React.ReactNode;
  labelWidth?: React.CSSProperties['width'];
  withBorder?: boolean;
  paperProps?: PaperProps;
};
