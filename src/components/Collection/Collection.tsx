import type { BadgeProps, MantineSpacing } from '@mantine/core';
import { Badge, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Fragment } from 'react';
import { DsBadge } from '~/components/AppLayout/ShellDs/ContentDs';

export function Collection<T>({
  items,
  renderItem,
  limit = 5,
  spacing = 4,
  grouped = false,
  badgeProps,
  ds,
}: Props<T>) {
  const [opened, { open, close }] = useDisclosure();

  if (!items.length) return null;

  const displayedItems = items.slice(0, limit);
  const collapsedItems = items.slice(limit);

  const renderedItems = (
    <>
      {displayedItems.map((item, index) => (
        <Fragment key={'displayed' + index}>{renderItem(item, index)}</Fragment>
      ))}
      {collapsedItems.length > 0 && opened
        ? collapsedItems.map((item, index) => (
            <Fragment key={'collapsed' + index}>{renderItem(item, index)}</Fragment>
          ))
        : null}
      {collapsedItems.length > 0 &&
        ds &&
        (!opened ? (
          <DsBadge
            component="button"
            color="gray"
            size="sm"
            onClick={open}
            style={{ cursor: 'pointer' }}
          >
            + {collapsedItems.length}
          </DsBadge>
        ) : (
          <DsBadge
            component="button"
            color="gray"
            size="sm"
            onClick={close}
            style={{ cursor: 'pointer' }}
          >
            - Hide
          </DsBadge>
        ))}
      {collapsedItems.length > 0 &&
        !ds &&
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
  /** `@civitai/components` markup for the show/hide toggle (`modelPageDesignSystemMarkup`). Ignores `badgeProps`; needs `grouped` off. */
  ds?: boolean;
};
