import type { BadgeProps, MantineSpacing } from '@mantine/core';
import { Badge, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Fragment } from 'react';
import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';

export function Collection<T>({
  items,
  renderItem,
  limit = 5,
  spacing = 4,
  grouped = false,
  badgeProps,
}: Props<T>) {
  const [opened, { open, close }] = useDisclosure();

  if (!items.length) return null;

  const displayedItems = items.slice(0, limit);
  const collapsedItems = items.slice(limit);

  const renderedItems = (
    <>
      {displayedItems.map((item, index) => (
        <Fragment key={'displayed' + index}>
          {createRenderElement(renderItem, index, item)}
        </Fragment>
      ))}
      {collapsedItems.length > 0 && opened
        ? collapsedItems.map((item, index) => (
            <Fragment key={'collapsed' + index}>
              {createRenderElement(renderItem, index, item)}
            </Fragment>
          ))
        : null}
      {collapsedItems.length > 0 &&
        (!opened ? (
          <Badge
            component="button"
            color="gray"
            size="sm"
            {...badgeProps}
            onClick={open}
            style={{ cursor: 'pointer' }}
          >
            + {collapsedItems.length}
          </Badge>
        ) : (
          <Badge
            component="button"
            color="gray"
            size="sm"
            {...badgeProps}
            onClick={close}
            style={{ cursor: 'pointer' }}
          >
            - Hide
          </Badge>
        ))}
    </>
  );

  return grouped ? <Group gap={spacing}>{renderedItems}</Group> : renderedItems;
}

type Props<T> = {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  limit?: number;
  spacing?: MantineSpacing;
  grouped?: boolean;
  badgeProps?: Omit<BadgeProps, 'children'>;
};

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, item) => <RenderComponent index={index} {...item} />
);
