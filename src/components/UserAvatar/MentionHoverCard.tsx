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

type Mention = {
  userId: number | null;
  username: string | null;
  linked: boolean;
  rect: DOMRect;
};

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
  const idAttr = el.getAttribute('data-id') ?? '';
  const raw = idAttr.replace(/^mention:/, '');
  const label = el.getAttribute('data-label');
  const userId = /^\d+$/.test(raw) ? Number(raw) : null;
  const username = label ?? (userId ? null : raw || null);
  if (!userId && !username) return null;

  // `closest` walks ancestors only, so a link *inside* the mention would never
  // be checked — and the renderer never produces one.
  if (el.querySelector('a')) return null;

  const anchor = el.closest('a');
  // The profile the renderer would have linked to. `data-label` is what it uses
  // when present, falling back to the raw id attribute — so a mention stored
  // without a label still validates instead of silently losing its card.
  if (anchor && !linksToProfile(anchor, label ?? idAttr)) return null;

  return { userId, username, linked: !!anchor };
}

/**
 * Same-origin and same profile. Comparing only the path would accept
 * `https://evil.example/user/Justin`, which is the whole attack.
 */
function linksToProfile(anchor: HTMLAnchorElement, expected: string) {
  try {
    const url = new URL(anchor.getAttribute('href') ?? '', window.location.href);
    if (url.origin !== window.location.origin) return false;
    // Usernames resolve case-insensitively, so a link that works must pass.
    return (
      decodeURIComponent(url.pathname).replace(/\/$/, '').toLowerCase() ===
      `/user/${expected}`.toLowerCase()
    );
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
    // Mantine's own Escape handling is a React prop on the dropdown, which only
    // sees keys pressed inside it — and nothing ever focuses a hover card.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMention(null);
    };
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown);
    };
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
        <HoverCreatorCard
          userId={mention.userId}
          username={mention.username}
          // The href was validated against the label, but the card is keyed on
          // the id — independent attributes, so they can disagree. A link and a
          // card that name different people is the same borrowed identity in a
          // quieter form.
          expectUsername={mention.linked ? mention.username : undefined}
        />
      </CreatorHoverDropdown>
    </Popover>
  );
}
