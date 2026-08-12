import { Popover } from '@mantine/core';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  HOVER_CARD_WIDTH,
  HOVER_DELAY_MS,
  HoverCreatorCard,
} from '~/components/UserAvatar/UserHoverCard';

// Long enough to cross the gap between the mention and the dropdown, short
// enough that the card doesn't linger over what you moved on to read.
const CLOSE_DELAY_MS = 150;

type Mention = { userId: number | null; username: string | null; rect: DOMRect };

/**
 * A mention inside rendered comment HTML resolves to `mention:<userId>`; older
 * content stored the username instead, and the link is built from `data-label`
 * either way.
 */
function readMention(el: HTMLElement): Omit<Mention, 'rect'> | null {
  const raw = el.getAttribute('data-id')?.replace(/^mention:/, '') ?? '';
  const label = el.getAttribute('data-label');
  const userId = /^\d+$/.test(raw) ? Number(raw) : null;
  const username = label ?? (userId ? null : raw || null);
  if (!userId && !username) return null;
  return { userId, username };
}

/**
 * Creator cards for @mentions in rendered HTML.
 *
 * The mentions are markup inside `dangerouslySetInnerHTML`, not React nodes, so
 * there is nothing to wrap in a `HoverCard`. Hover is delegated from the
 * container instead and the card is anchored to a zero-size element parked over
 * the mention's bounding box.
 */
export function MentionHoverCard({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [mention, setMention] = useState<Mention | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cancelOpen = () => clearTimeout(openTimer.current);
    const cancelClose = () => clearTimeout(closeTimer.current);
    const scheduleClose = () => {
      cancelClose();
      closeTimer.current = setTimeout(() => setMention(null), CLOSE_DELAY_MS);
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-type="mention"]');
      if (!el) return;
      cancelClose();
      cancelOpen();
      const parsed = readMention(el);
      if (!parsed) return;
      openTimer.current = setTimeout(
        () => setMention({ ...parsed, rect: el.getBoundingClientRect() }),
        HOVER_DELAY_MS
      );
    };

    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('[data-type="mention"]');
      if (!el) return;
      cancelOpen();
      scheduleClose();
    };

    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);
    // The anchor is a fixed-position box over the mention, so it goes stale the
    // moment the page moves under it. Closing beats chasing the rect.
    const onScroll = () => {
      cancelOpen();
      setMention(null);
    };
    window.addEventListener('scroll', onScroll, true);

    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', onScroll, true);
      cancelOpen();
      cancelClose();
    };
  }, [containerRef]);

  if (!mention) return null;

  const { rect } = mention;

  return (
    <Popover
      opened
      width={HOVER_CARD_WIDTH}
      shadow="sm"
      withArrow
      withinPortal
      position="bottom-start"
      offset={4}
    >
      <Popover.Target>
        <div
          className="pointer-events-none fixed"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      </Popover.Target>
      <Popover.Dropdown
        p={0}
        className="overflow-hidden"
        onMouseEnter={() => clearTimeout(closeTimer.current)}
        onMouseLeave={() => setMention(null)}
      >
        <HoverCreatorCard userId={mention.userId} username={mention.username} />
      </Popover.Dropdown>
    </Popover>
  );
}
