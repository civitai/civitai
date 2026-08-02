import { Loader, Popover, ScrollArea, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconMoodSmile } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { cloneElement, isValidElement, useMemo, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export function StickerPicker({
  onSelect,
  target,
  disabled,
  position = 'top-end',
}: {
  onSelect: (sticker: ResolvedSticker) => void;
  target?: React.ReactNode;
  disabled?: boolean;
  position?: 'top' | 'top-end' | 'top-start' | 'bottom' | 'bottom-end' | 'bottom-start';
}) {
  const features = useFeatureFlags();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const { sticker, isLoading } = useOwnedSticker();
  const { data: balanceRows } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: features.stickers,
  });
  const balances = useMemo(
    () => new Map((balanceRows ?? []).map((b) => [b.cosmeticId, b.remaining])),
    [balanceRows]
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
          cloneElement(target as ReactElement<{ onClick?: () => void }>, {
            onClick: () => setOpened((o) => !o),
          })
        ) : (
          <LegacyActionIcon
            variant="subtle"
            color="gray"
            disabled={disabled}
            aria-label="Insert sticker"
            onClick={() => setOpened((o) => !o)}
          >
            <IconMoodSmile />
          </LegacyActionIcon>
        )}
      </Popover.Target>
      <Popover.Dropdown p="xs">
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
                  const remaining = balances.get(item.id);
                  const exhausted = remaining === 0;
                  return (
                    <UnstyledButton
                      key={item.id}
                      // Stickers are consumable in comments; showing the balance
                      // here is what keeps "not enough uses" from arriving as a
                      // failed submit.
                      title={
                        remaining == null ? `:${item.slug}:` : `:${item.slug}: · ${remaining} left`
                      }
                      disabled={exhausted}
                      className="relative flex items-center justify-center rounded p-1 hover:bg-gray-2 disabled:opacity-40 dark:hover:bg-dark-5"
                      onClick={() => {
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
                      {remaining != null && (
                        <span className="absolute bottom-0 right-0 rounded bg-dark-7/80 px-1 text-[10px] leading-tight text-white">
                          {remaining}
                        </span>
                      )}
                    </UnstyledButton>
                  );
                })}
              </div>
            </ScrollArea.Autosize>
          )}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
