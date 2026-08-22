import { Button, Group, Text, ThemeIcon, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StickerBookGrid } from '~/components/StickerBook/StickerBookGrid';
import type { StickerBookSide } from '~/components/StickerBook/sticker-book.util';
import type { RouterOutput } from '~/types/router';

type BookItems = RouterOutput['stickerBook']['get']['placed'];

/**
 * One band of the page.
 *
 * Banded rather than stacked, and alternating its background, because the
 * profile overview reads that way and this tab sits beside it — Justin's call on
 * review. The negative margin lets the band's colour reach the container's edges
 * while the content stays on the page's own gutter.
 */
export function StickerBookBand({
  title,
  icon,
  action,
  shaded,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  /** Every other band, so the boundary between two is visible without a rule. */
  shaded?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`-mx-3 px-3 py-6 ${shaded ? 'bg-gray-1 dark:bg-dark-8' : ''}`.trim()}>
      <Group justify="space-between" align="center" mb="md" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" className="min-w-0">
          <ThemeIcon size="xl" color="dark" variant="default">
            {icon}
          </ThemeIcon>
          <Title order={3} className="truncate">
            {title}
          </Title>
        </Group>
        {action}
      </Group>
      {children}
    </section>
  );
}

/** A band of images, with the "View all" that opens the whole section. */
export function StickerBookSection({
  title,
  icon,
  emptyMessage,
  items,
  side,
  viewAllHref,
  shaded,
}: {
  title: string;
  icon: ReactNode;
  emptyMessage: string;
  items: BookItems;
  side: StickerBookSide;
  viewAllHref: string;
  shaded?: boolean;
}) {
  return (
    <StickerBookBand
      title={title}
      icon={icon}
      shaded={shaded}
      action={
        !!items.length && (
          // The overview's section action, prop for prop — same height, same
          // subtle variant, same arrow. Two "View all"s that look different on
          // adjacent tabs read as two different affordances.
          <Button
            component={Link}
            href={viewAllHref}
            h={34}
            variant="subtle"
            rightSection={<IconArrowRight size={16} />}
          >
            <Text inherit>View all</Text>
          </Button>
        )
      }
    >
      {items.length ? (
        <StickerBookGrid items={items} side={side} emptyMessage={emptyMessage} />
      ) : (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      )}
    </StickerBookBand>
  );
}
