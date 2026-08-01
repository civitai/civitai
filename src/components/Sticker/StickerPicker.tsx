import { Loader, Popover, ScrollArea, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconMoodSmile } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const { sticker, isLoading } = useOwnedSticker();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sticker;
    return sticker.filter((x) => x.slug.includes(needle) || x.name.toLowerCase().includes(needle));
  }, [sticker, query]);

  return (
    <Popover opened={opened} onChange={setOpened} position={position} withArrow shadow="md">
      <Popover.Target>
        {target ? (
          <UnstyledButton disabled={disabled} onClick={() => setOpened((o) => !o)}>
            {target}
          </UnstyledButton>
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
              You don&apos;t own any sticker yet. Grab some in the shop.
            </Text>
          ) : !filtered.length ? (
            <Text size="xs" c="dimmed" ta="center" py="sm">
              No matches
            </Text>
          ) : (
            <ScrollArea.Autosize mah={220} type="auto">
              <div className="grid grid-cols-6 gap-1">
                {filtered.map((item) => (
                  <UnstyledButton
                    key={item.id}
                    title={`:${item.slug}:`}
                    className="flex items-center justify-center rounded p-1 hover:bg-gray-2 dark:hover:bg-dark-5"
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
                  </UnstyledButton>
                ))}
              </div>
            </ScrollArea.Autosize>
          )}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
