import { Popover } from '@mantine/core';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  CREATOR_HOVER_DROPDOWN_CLASS,
  CreatorHoverDropdown,
  HOVER_CARD_WIDTH,
  HOVER_CARD_Z_INDEX,
  HOVER_CLOSE_DELAY_MS,
  HOVER_DELAY_MS,
  HoverCreatorCard,
  useHoverCapable,
  useNestedHoverCard,
} from '~/components/UserAvatar/UserHoverCard';

type Mention = { userId: number | null; username: string | null; rect: DOMRect };

/**
 * The user a mention element claims to be, or null if the claim can't be trusted.
 *
 * `data-type="mention"` is storable on a span by anyone who can post — it always
 * has been, since the write sanitizer allows it. Styled text making that claim
 * was harmless; a card showing a real creator's avatar, badges and stats is a
 * credential, so a mention wrapped in a link somewhere else would let a comment
 * vouch for someone it is not sending you to. Where there is a link, its target
 * has to be that user's profile.
 */
function readMention(el: HTMLElement): Omit<Mention, 'rect'> | null {
  const raw = el.getAttribute('data-id')?.replace(/^mention:/, '') ?? '';
  const label = el.getAttribute('data-label');
  const userId = /^\d+$/.test(raw) ? Number(raw) : null;
  const username = label ?? (userId ? null : raw || null);
  if (!userId && !username) return null;

  const anchor = el.closest('a');
  if (anchor && !linksToProfile(anchor, label ?? username)) return null;

  return { userId, username };
}

function linksToProfile(anchor: HTMLAnchorElement, username: string | null) {
  if (!username) return false;
  try {
    const { pathname } = new URL(anchor.getAttribute('href') ?? '', window.location.origin);
    return decodeURIComponent(pathname).replace(/\/$/, '') === `/user/${username}`;
  } catch {
    return false;
  }
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
  const nested = useNestedHoverCard();
  const hoverCapable = useHoverCapable();
  const enabled = hoverCapable && !nested;

  const [mention, setMention] = useState<Mention | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const cancelOpen = () => clearTimeout(openTimer.current);
    const cancelClose = () => clearTimeout(closeTimer.current);

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-type="mention"]');
      if (!el) return;
      cancelClose();
      cancelOpen();
      const parsed = readMention(el);
      if (!parsed) return;
      openTimer.current = setTimeout(() => {
        // The container swaps its whole innerHTML when the html prop changes, so
        // the element captured a delay ago may be detached — and a detached
        // element measures as all zeros, which would pin the card to the corner
        // of the viewport.
        if (!el.isConnected) return;
        setMention({ ...parsed, rect: el.getBoundingClientRect() });
      }, HOVER_DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('[data-type="mention"]');
      if (!el) return;
      cancelOpen();
      cancelClose();
      closeTimer.current = setTimeout(() => setMention(null), HOVER_CLOSE_DELAY_MS);
    };

    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);

    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseout', onOut);
      cancelOpen();
      cancelClose();
    };
  }, [containerRef, enabled]);

  // Only while a card is open: the anchor is a fixed box over the mention, so it
  // goes stale the moment the page moves under it, and closing beats chasing the
  // rect. Subscribing unconditionally would put one capture-phase window
  // listener per rendered comment on every scroll frame.
  useEffect(() => {
    if (!mention) return;
    const onScroll = (e: Event) => {
      // Scrolling inside the card itself shouldn't dismiss it.
      if (e.target instanceof Element && e.target.closest(`.${CREATOR_HOVER_DROPDOWN_CLASS}`))
        return;
      setMention(null);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [mention]);

  if (!mention) return null;

  const { rect } = mention;

  return (
    <Popover
      opened
      // Controlled, so Mantine's own dismissals (outside click, Escape) come
      // back through here rather than being swallowed.
      onChange={(opened) => !opened && setMention(null)}
      width={HOVER_CARD_WIDTH}
      shadow="sm"
      withArrow
      withinPortal
      withRoles={false}
      zIndex={HOVER_CARD_Z_INDEX}
      position="bottom-start"
      offset={4}
    >
      <Popover.Target>
        <div
          className="pointer-events-none fixed"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      </Popover.Target>
      <CreatorHoverDropdown
        component={Popover.Dropdown}
        onMouseEnter={() => clearTimeout(closeTimer.current)}
        onMouseLeave={() => setMention(null)}
      >
        <HoverCreatorCard userId={mention.userId} username={mention.username} />
      </CreatorHoverDropdown>
    </Popover>
  );
}
