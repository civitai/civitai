import { Anchor, Group, Popover, Skeleton, Text } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
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
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { trpc } from '~/utils/trpc';

type Hovered = { cosmeticId: number; rect: DOMRect };

/**
 * Who made the sticker in a comment, and where to buy it.
 *
 * Same shape as `MentionHoverCard` and for the same reason: a rendered sticker
 * is an `<img>` built imperatively inside `dangerouslySetInnerHTML`, so there is
 * no React node to wrap. Hover is delegated from the container and the card is
 * anchored to a zero-size box parked over the sticker.
 *
 * 🔴 MOUNTED BY `RenderHtml` UNDER `allowStickers`, WHICH IS WHY IT IS NOT IN
 * `Sticker.tsx`. That component is shared with chat, and chat renders stickers
 * inline in DMs. Justin's call was comments first and DMs as a separate
 * decision — a hover card in a DM turns any sticker anyone sends you into a
 * route to a stranger's shop, which is a product judgement rather than a
 * rendering one. Putting the card on the shared component would have shipped
 * that decision by accident.
 *
 * The identity is not taken on trust from the markup: `RenderHtml` only draws a
 * sticker whose `data-id` resolved against server-supplied cosmetics, and the
 * name and shop link here come from the server keyed on that same id. Nothing
 * builds a href from a username — see `getStickerAttribution`.
 */
export function StickerAttributionHoverCard({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const nested = useNestedHoverCard();
  const hoverCapable = useHoverCapable();
  const enabled = hoverCapable && !nested;

  const [hovered, setHovered] = useState<Hovered | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const cancelOpen = () => clearTimeout(openTimer.current);
    const cancelClose = () => clearTimeout(closeTimer.current);

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        'span[data-type="sticker"]'
      );
      if (!el) return;
      cancelClose();
      cancelOpen();

      // The span must carry the image RenderHtml injects. An id that did not
      // resolve leaves the span in place with the author's own text inside it —
      // attaching a card to that would put site chrome on words someone chose,
      // and "has a card" must never be broader than "drew a sticker".
      if (!el.querySelector('img')) return;

      const raw = el.getAttribute('data-id') ?? '';
      if (!/^\d+$/.test(raw)) return;
      const cosmeticId = Number(raw);

      openTimer.current = setTimeout(() => {
        // The container swaps its whole innerHTML when the html prop changes, so
        // an element captured a delay ago may be detached — and a detached
        // element measures as all zeros, pinning the card to the viewport corner.
        if (!el.isConnected) return;
        setHovered({ cosmeticId, rect: el.getBoundingClientRect() });
      }, HOVER_DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('span[data-type="sticker"]');
      if (!el) return;
      cancelOpen();
      cancelClose();
      closeTimer.current = setTimeout(() => setHovered(null), HOVER_CLOSE_DELAY_MS);
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

  // Only while a card is open: the anchor is a fixed box over the sticker, so it
  // goes stale the moment the page moves under it.
  useEffect(() => {
    if (!hovered) return;
    const onScroll = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(`.${CREATOR_HOVER_DROPDOWN_CLASS}`))
        return;
      setHovered(null);
    };
    // No Escape handler, deliberately — the same reason as `MentionHoverCard`:
    // a modal binds Escape as a capturing window listener, so a card opened
    // inside one (a comment thread modal, which is one of the four surfaces
    // this renders on) would take the modal down with it. Mouseleave, scroll
    // and outside-click already dismiss it.
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [hovered]);

  if (!hovered) return null;

  return (
    <StickerAttributionCard
      hovered={hovered}
      onClose={() => setHovered(null)}
      onDropdownEnter={() => clearTimeout(closeTimer.current)}
    />
  );
}

/**
 * Split out so the query is mounted with the card rather than with every comment
 * on the page — one sticker's attribution, asked for when someone hovers it.
 */
function StickerAttributionCard({
  hovered,
  onClose,
  onDropdownEnter,
}: {
  hovered: Hovered;
  onClose: () => void;
  onDropdownEnter: () => void;
}) {
  const { rect, cosmeticId } = hovered;
  const { data, isLoading } = trpc.cosmetic.getStickerAttribution.useQuery(
    { ids: [cosmeticId] },
    { staleTime: 5 * 60_000 }
  );
  const raw = data?.[0];

  // A block hides that creator's shop entries already — `getBlockedPairIds` is
  // applied to creator-made cosmetics in the shop for exactly this. The sticker's
  // creator is not the comment's author, so comment-level filtering never sees
  // them: without this, blocking someone still leaves their storefront one hover
  // away on any comment using their art. The name stays; the route and the
  // creator card do not.
  const hiddenUsers = useHiddenPreferencesData().hiddenUsers;
  const blocked = !!raw?.creatorId && hiddenUsers.some((user) => user.id === raw.creatorId);
  const sticker = raw && blocked ? { ...raw, shopHref: null, creatorId: null } : raw;

  return (
    <Popover
      opened
      onChange={(opened) => !opened && onClose()}
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
        onMouseEnter={onDropdownEnter}
        onMouseLeave={onClose}
      >
        <Group gap={6} px="sm" py={6} wrap="nowrap" className="min-w-0">
          <IconSticker size={14} className="shrink-0 text-yellow-6" />
          {isLoading ? (
            <Skeleton height={12} width={140} />
          ) : (
            <Text size="xs" c="dimmed" className="min-w-0 truncate">
              {sticker?.shopHref ? (
                <Anchor
                  component={Link}
                  href={sticker.shopHref}
                  underline="always"
                  fw={600}
                  inherit
                >
                  {sticker.name}
                </Anchor>
              ) : (
                // A sticker whose creator's account is gone still has a name
                // worth showing; it just has nowhere to link to.
                <Text span fw={600} inherit>
                  {sticker?.name}
                </Text>
              )}
              {sticker?.creatorName && <> by {sticker.creatorName}</>}
            </Text>
          )}
        </Group>
        {sticker?.creatorName && !blocked && (
          <HoverCreatorCard userId={sticker.creatorId} username={sticker.creatorName} />
        )}
      </CreatorHoverDropdown>
    </Popover>
  );
}
