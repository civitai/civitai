import { Loader, Popover, ScrollArea, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconMoodSmile } from '@tabler/icons-react';
import clsx from 'clsx';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import { cloneElement, isValidElement, useMemo, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { StickerTopUp } from '~/components/Sticker/StickerTopUp';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { StickerSurface } from '~/shared/utils/sticker-token';
import { STICKER_SURFACES, stickerBalanceLabel } from '~/shared/utils/sticker-token';
import { trpc } from '~/utils/trpc';

/**
 * Opening the picker must not move focus out of the composer. Two things break
 * when it does: the caret is lost, so the sticker lands wherever `focus()` puts
 * it rather than where the author was typing; and a composer validating on blur
 * (`CommentForm` uses `mode: 'onBlur'`) fires "Cannot be empty" the moment the
 * picker is clicked, then keeps showing it — pre-submit, React Hook Form doesn't
 * re-validate on change.
 */
const keepComposerFocus = (e: ReactMouseEvent) => e.preventDefault();

export function StickerPicker({
  onSelect,
  surface = 'comment',
  target,
  disabled,
  position = 'top-end',
}: {
  onSelect: (sticker: ResolvedSticker) => void;
  /** Balances are only meaningful where placements are charged. */
  surface?: StickerSurface;
  target?: React.ReactNode;
  disabled?: boolean;
  position?: 'top' | 'top-end' | 'top-start' | 'bottom' | 'bottom-end' | 'bottom-start';
}) {
  const features = useFeatureFlags();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  // The sticker the author just tried to place with nothing left. Offering the
  // top-up here is the whole point — a link to the shop loses the composer.
  const [topUp, setTopUp] = useState<ResolvedSticker | null>(null);
  const { sticker, isLoading } = useOwnedSticker();
  // DMs are free, so a "3 left" badge there would be actively misleading.
  const showBalances = STICKER_SURFACES[surface].consumes;
  const { data: balanceRows } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: features.stickers && showBalances,
  });
  // Distinguishes "unlimited" (row present, remaining null) from "not loaded
  // yet" (no row) — they render differently and used to look identical.
  const balancesLoaded = showBalances && !!balanceRows;
  const balances = useMemo(
    () => new Map((showBalances ? balanceRows ?? [] : []).map((b) => [b.cosmeticId, b.remaining])),
    [balanceRows, showBalances]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sticker;
    return sticker.filter((x) => x.slug.includes(needle) || x.name.toLowerCase().includes(needle));
  }, [sticker, query]);

  // Gated at the single mount point every surface shares, so chat and the RTE
  // toolbar can't drift. Rendering is unaffected — that lives in <Sticker>.
  if (!features.stickers) return null;

  return (
    <Popover opened={opened} onChange={setOpened} position={position} withArrow shadow="md">
      <Popover.Target>
        {/* A supplied target is usually already a button (e.g. an RTE toolbar
            control), so clone the toggle onto it rather than wrapping — nesting
            buttons is invalid markup and breaks keyboard activation. */}
        {isValidElement(target) ? (
          cloneElement(
            target as ReactElement<{
              onClick?: () => void;
              onMouseDown?: (e: ReactMouseEvent) => void;
            }>,
            { onClick: () => setOpened((o) => !o), onMouseDown: keepComposerFocus }
          )
        ) : (
          <LegacyActionIcon
            variant="subtle"
            color="gray"
            disabled={disabled}
            aria-label="Insert sticker"
            onClick={() => setOpened((o) => !o)}
            onMouseDown={keepComposerFocus}
          >
            <IconMoodSmile />
          </LegacyActionIcon>
        )}
      </Popover.Target>
      <Popover.Dropdown p="xs">
        {topUp ? (
          <div className="w-64">
            <StickerTopUp
              sticker={topUp}
              onCancel={() => setTopUp(null)}
              // They clicked the sticker to place it and hit the wall; having
              // paid, they shouldn't have to find it again.
              onPurchased={() => {
                onSelect(topUp);
                setTopUp(null);
                setOpened(false);
                setQuery('');
              }}
            />
          </div>
        ) : (
          <div className="flex w-64 flex-col gap-2">
            <TextInput
              size="xs"
              placeholder="Search sticker"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {isLoading ? (
              <div className="flex justify-center py-4">
                <Loader size="sm" />
              </div>
            ) : !sticker.length ? (
              <Text size="xs" c="dimmed" ta="center" py="sm">
                You don&apos;t own any stickers yet. Grab some in the shop.
              </Text>
            ) : !filtered.length ? (
              <Text size="xs" c="dimmed" ta="center" py="sm">
                No matches
              </Text>
            ) : (
              <ScrollArea.Autosize mah={220} type="auto">
                <div className="grid grid-cols-6 gap-1">
                  {filtered.map((item) => {
                    const remaining = balancesLoaded ? balances.get(item.id) ?? null : undefined;
                    const exhausted = remaining === 0;
                    const balanceLabel = stickerBalanceLabel(remaining);
                    return (
                      <UnstyledButton
                        key={item.id}
                        // Stickers are consumable in comments; showing the balance
                        // here is what keeps "not enough uses" from arriving as a
                        // failed submit.
                        title={
                          remaining === undefined
                            ? `:${item.slug}:`
                            : remaining === null
                            ? `:${item.slug}: · unlimited`
                            : exhausted
                            ? `:${item.slug}: · out of uses — buy more`
                            : `:${item.slug}: · ${remaining} left`
                        }
                        className={clsx(
                          'relative flex items-center justify-center rounded p-1 hover:bg-gray-2 dark:hover:bg-dark-5',
                          exhausted && 'opacity-40'
                        )}
                        onClick={() => {
                          // Exhausted opens the top-up rather than doing nothing:
                          // a dead button is where the author leaves.
                          if (exhausted) {
                            setTopUp(item);
                            return;
                          }
                          onSelect(item);
                          setOpened(false);
                          setQuery('');
                        }}
                      >
                        <EdgeImage
                          src={item.url}
                          options={{ width: 64, anim: item.animated }}
                          style={{ width: 28, height: 28, objectFit: 'contain' }}
                        />
                        {balanceLabel && (
                          <span className="absolute bottom-0 right-0 rounded bg-dark-7/80 px-1 text-[10px] leading-tight text-white">
                            {balanceLabel}
                          </span>
                        )}
                      </UnstyledButton>
                    );
                  })}
                </div>
              </ScrollArea.Autosize>
            )}
          </div>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
