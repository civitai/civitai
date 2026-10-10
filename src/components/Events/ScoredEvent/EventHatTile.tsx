import { Group, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { CosmeticShopItemPreviewModal } from '~/components/CosmeticShop/CosmeticShopItemPreviewModal';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { EVENT_CARD_SURFACE } from '~/components/Events/ScoredEvent/scored-event.utils';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticShopItemGetById } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';

/**
 * How a tile is dressed by its price tier, cheapest first: plain; then a team-colour border over a
 * team-tinted fill; then a foil border of the team colour and gold over a fill that shades from the
 * team colour to gold. Every tier above the second keeps the foil.
 */
function tierStyle(tier: number, color: string): CSSProperties | undefined {
  if (tier === 0) return undefined;
  const tint = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, var(--tile-bg))`;
  // Custom properties, read by the TIERED classes: they beat the theme's dark: border and fill.
  if (tier === 1)
    return {
      '--tier-border': `color-mix(in srgb, ${color} 55%, transparent)`,
      '--tier-bg': `linear-gradient(170deg, ${tint(color, 14)}, var(--tile-bg) 70%)`,
      '--tier-shadow': `0 0 16px -6px ${color}`,
    } as CSSProperties;
  return {
    '--tier-border': 'transparent',
    '--tier-bg': `linear-gradient(160deg, ${tint(color, 18)}, var(--tile-bg) 55%, ${tint(
      '#fcc419',
      14
    )}) padding-box, linear-gradient(135deg, ${color}, #fcc419, ${color}) border-box`,
    '--tier-shadow': `0 0 22px -6px ${color}`,
  } as CSSProperties;
}

const TIERED =
  '![border-color:var(--tier-border)] ![background:var(--tier-bg)] [box-shadow:var(--tier-shadow)]';

/**
 * A hat for sale on the event page. Opens the shop's own preview, so buying here is buying in the
 * shop: same checks, same purchase.
 */
export function EventHatTile({
  item,
  color = 'var(--mantine-color-blue-5)',
  tier = 0,
}: {
  item: CosmeticShopItemGetById;
  color?: string;
  /** The item's price tier on the shelf, 0 for the cheapest. */
  tier?: number;
}) {
  const url = (item.cosmetic?.data as { url?: unknown } | null)?.url;
  const purchases = (item.meta as CosmeticShopItemMeta | null)?.purchases ?? 0;
  const soldOut = item.availableQuantity != null && item.availableQuantity - purchases <= 0;
  // The price is in the site's Buzz (yellow, or green on the green site), coloured as the shop does.
  const [buzzType] = useAvailableBuzz();
  const buzz = useBuzzCurrencyConfig(buzzType);

  return (
    <UnstyledButton
      disabled={soldOut || !item.cosmetic}
      onClick={() =>
        dialogStore.trigger({
          component: CosmeticShopItemPreviewModal,
          props: { shopItem: item },
        })
      }
      data-tier={tier}
      aria-label={
        soldOut ? `${item.title}, sold out` : item.cosmetic ? `Buy ${item.title}` : item.title
      }
      className={clsx(
        'group flex flex-col gap-2 rounded-lg border-2 border-solid border-gray-3 p-2 transition [--tile-bg:white]',
        'dark:border-dark-4 dark:[--tile-bg:var(--mantine-color-dark-6)]',
        EVENT_CARD_SURFACE,
        'enabled:hover:-translate-y-0.5 enabled:hover:shadow-lg disabled:opacity-50',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        tier > 0 && TIERED
      )}
      style={tierStyle(tier, color)}
    >
      {typeof url === 'string' && <HatArt url={url} color={color} width={192} />}
      <Text fw={700} size="sm" truncate px={2}>
        {item.title}
      </Text>
      <Group
        gap={4}
        justify="center"
        wrap="nowrap"
        className="rounded-full py-1 text-sm font-bold transition-colors"
        style={
          soldOut
            ? undefined
            : {
                background: `color-mix(in srgb, ${buzz.color} 16%, transparent)`,
                color: buzz.color,
              }
        }
        data-testid="tile-buy"
      >
        {soldOut ? (
          <Text size="sm" fw={700} c="dimmed">
            Sold out
          </Text>
        ) : (
          <>
            <span>Buy</span>
            <CurrencyIcon currency="BUZZ" type={buzzType} size={14} />
            <span className="tabular-nums">{numberWithCommas(item.unitAmount)}</span>
          </>
        )}
      </Group>
    </UnstyledButton>
  );
}
