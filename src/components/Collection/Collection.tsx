import { Badge, Group, MantineNumberSize } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Fragment } from 'react';

export function Collection<T>({
  items,
  renderItem,
  limit = 5,
  spacing = 4,
  grouped = false,
}: Props<T>) {
  const [opened, { open }] = useDisclosure();

  if (!items.length) return null;

  const displayedItems = items.slice(0, limit);
  const collapsedItems = items.slice(limit);

  const renderedItems = (
    <>
      {displayedItems.map((item, index) => (
        <Fragment key={index}>{renderItem(item, index)}</Fragment>
      ))}
      {collapsedItems.length > 0 && opened
        ? collapsedItems.map((item, index) => (
            <Fragment key={index}>{renderItem(item, index)}</Fragment>
          ))
        : null}
      {collapsedItems.length > 0 && !opened ? (
        <Badge component="button" color="gray" size="sm" onClick={open} sx={{ cursor: 'pointer' }}>
          + {collapsedItems.length}
        </Badge>
      ) : null}
    </>
  );

  return grouped ? <Group spacing={spacing}>{renderedItems}</Group> : renderedItems;
}

type Props<T> = {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  limit?: number;
  spacing?: MantineNumberSize;
  grouped?: boolean;
};
