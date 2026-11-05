import { useState } from 'react';
import { Drawer, Select, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import clsx from 'clsx';
import { PAGE_MODAL_Z_INDEX } from '~/components/Dialog/Templates/PageModal';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatPicture } from '~/components/HatTurf/HatPicture';
import classes from '~/components/HatTurf/HatTurfTray.module.css';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { FALLBACK_COLOR } from '~/components/HatTurf/hat-turf.utils';
import { useChosenHat, useHatLooks, useHatStock } from '~/components/HatTurf/useHatTurf';
import { useIsMobile } from '~/hooks/useIsMobile';

type Sort = 'used' | 'most';

/**
 * The viewer's hats laid out like the sticker tray, with its search and sort. Picking one makes it
 * the hat that Place puts down.
 */
export function HatTurfTray({
  opened,
  onClose,
  onPicked,
}: {
  opened: boolean;
  onClose: () => void;
  onPicked: () => void;
}) {
  const feed = useTurfFeed();
  const mobile = useIsMobile({ type: 'media' });
  const teamColor = useTeamColor();
  const stock = useHatStock();
  const pick = useHatTurfStore((state) => state.pick);
  const { hats, cosmeticId } = useChosenHat();
  const lookOf = useHatLooks(opened);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('used');
  if (!feed) return null;

  const color = (feed.team && teamColor(feed.team)) || FALLBACK_COLOR;
  const term = search.trim().toLowerCase();
  // The query already arrives most recently used first.
  const shown = (hats ?? [])
    .map((hat, index) => ({ ...hat, name: lookOf(hat.cosmeticId)?.name ?? `Hat ${index + 1}` }))
    .filter((hat) => !term || hat.name.toLowerCase().includes(term));
  if (sort === 'most') shown.sort((a, b) => b.usageCount - a.usageCount);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position={mobile ? 'bottom' : 'right'}
      size={360}
      // The image modal is a PageModal; at Mantine's default the drawer opens hidden under it.
      zIndex={PAGE_MODAL_Z_INDEX + 1}
      title="Your hats"
      classNames={{ content: mobile ? classes.sheet : undefined }}
    >
      <div
        data-autofocus
        tabIndex={-1}
        className="outline-none"
        data-testid="hat-turf-tray"
        style={{ '--tile-ring': color } as React.CSSProperties}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={classes.tools}>
          <TextInput
            size="xs"
            radius="xl"
            className="min-w-0 flex-1"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search"
            aria-label="Search your hats"
            leftSection={<IconSearch size={14} />}
          />
          <Select
            size="xs"
            radius="xl"
            className="w-36 shrink-0"
            value={sort}
            onChange={(value) => setSort(value === 'most' ? 'most' : 'used')}
            data={[
              { value: 'used', label: 'Recently used' },
              { value: 'most', label: 'Most used' },
            ]}
            aria-label="Sort your hats"
            allowDeselect={false}
            comboboxProps={{ withinPortal: true, zIndex: PAGE_MODAL_Z_INDEX + 2 }}
          />
        </div>
        {stock && (
          <Text size="xs" c="dimmed" mb={8}>
            {stock.available} of {stock.cap} left
          </Text>
        )}
        {!hats?.length && <Text size="sm">You have no hats to place yet.</Text>}
        {!!hats?.length && !shown.length && <Text size="sm">No hats match.</Text>}
        <div className={classes.grid}>
          {shown.map((hat) => (
            <button
              type="button"
              key={hat.cosmeticId}
              aria-pressed={hat.cosmeticId === cosmeticId}
              className={clsx(classes.tile, hat.cosmeticId === cosmeticId && classes.active)}
              onClick={() => {
                pick(hat.cosmeticId);
                onPicked();
              }}
            >
              <HatPicture data={lookOf(hat.cosmeticId)?.data} color={color} size={72} />
              <span className={classes.name}>{hat.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
