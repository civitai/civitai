import { Button, Skeleton, Text } from '@mantine/core';
import { IconEyeOff, IconLinkOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import {
  BrowsingLevelProvider,
  useBrowsingLevelDebounced,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import type { EmbedImage, EmbedModel } from '~/components/CivitaiEmbed/CivitaiEmbedProvider';
import {
  useCivitaiEmbedContext,
  useEmbedView,
} from '~/components/CivitaiEmbed/CivitaiEmbedProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { useInView } from '~/hooks/useInView';
import type { CivitaiEmbedItem, CivitaiEmbedType } from '~/shared/tiptap/civitai-embed.utils';
import { getCivitaiEmbedHref, toCivitaiEmbedItem } from '~/shared/tiptap/civitai-embed.utils';
import { Flags } from '~/shared/utils/flags';

const typeLabel = { model: 'model', image: 'image' } as const;

function EntityCard({ item, data }: { item: CivitaiEmbedItem; data: EmbedModel | EmbedImage }) {
  return item.type === 'model' ? (
    <ModelCard data={data as EmbedModel} linkVersionId={item.versionId} />
  ) : (
    <ImageCard data={data as EmbedImage} />
  );
}

function Tile({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="flex aspect-[7/9] w-full flex-col items-center justify-center gap-2 rounded-md border border-solid border-gray-3 bg-gray-0 p-4 text-center dark:border-dark-4 dark:bg-dark-6"
    >
      {children}
    </div>
  );
}

export function UnavailableTile({ item }: { item: CivitaiEmbedItem }) {
  const href = getCivitaiEmbedHref(item);
  return (
    <Tile testId="civitai-embed-unavailable">
      <IconLinkOff size={28} className="text-dimmed" />
      <Text size="sm" c="dimmed">
        This {typeLabel[item.type]} is not available
      </Text>
      <NextLink href={href} className="break-all text-xs">
        {href}
      </NextLink>
    </Tile>
  );
}

/**
 * Never renders the item's name or cover until Show: both can be explicit, and this viewer has
 * that level turned off. Only viewers with mature content on reach this; Show widens the level
 * for this one card, as ExplainHiddenImages' "Show Hidden" does, and the domain cap still wins.
 */
function MaturePlaceholder({
  item,
  data,
}: {
  item: CivitaiEmbedItem;
  data: EmbedModel | EmbedImage;
}) {
  const browsingLevel = useBrowsingLevelDebounced();
  const [revealed, setRevealed] = useState(false);

  if (revealed)
    return (
      <BrowsingLevelProvider browsingLevel={Flags.addFlag(browsingLevel, data.nsfwLevel)}>
        <EntityCard item={item} data={data} />
      </BrowsingLevelProvider>
    );

  return <MatureTile type={item.type} onShow={() => setRevealed(true)} />;
}

/** Without onShow (mature content off), the tile only says something is hidden. */
export function MatureTile({ type, onShow }: { type: CivitaiEmbedType; onShow?: () => void }) {
  return (
    <Tile testId={onShow ? 'civitai-embed-mature' : 'civitai-embed-hidden'}>
      <IconEyeOff size={28} className="text-dimmed" />
      <Text size="xs" tt="uppercase" fw={600} c="dimmed">
        {typeLabel[type]}
      </Text>
      <Text size="sm" c="dimmed">
        {onShow ? 'Mature content, hidden by your browsing settings' : 'Mature content hidden'}
      </Text>
      {onShow && (
        <Button size="compact-sm" variant="light" onClick={onShow}>
          Show
        </Button>
      )}
    </Tile>
  );
}

function EmbedCard({ item }: { item: CivitaiEmbedItem }) {
  const view = useEmbedView(item.type, item.id);
  const { ref, inView } = useInView();
  const requestLoad = useCivitaiEmbedContext()?.requestLoad;
  useEffect(() => {
    if (inView) requestLoad?.();
  }, [inView, requestLoad]);

  return (
    <div ref={ref} data-testid="civitai-embed-item" className="w-full min-w-0">
      {view.state === 'loading' && <Skeleton className="aspect-[7/9] w-full" radius="md" />}
      {view.state === 'card' && <EntityCard item={item} data={view.data} />}
      {view.state === 'mature' && <MaturePlaceholder item={item} data={view.data} />}
      {view.state === 'hidden' && <MatureTile type={item.type} />}
      {view.state === 'unavailable' && <UnavailableTile item={item} />}
    </div>
  );
}

export function CivitaiEmbedBlock({ items: rawItems }: { items: unknown }) {
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map(toCivitaiEmbedItem)
    .filter((item): item is CivitaiEmbedItem => !!item);
  if (!items.length) return null;

  return (
    <EmbedRow count={items.length}>
      {items.map((item, index) => (
        <EmbedCard key={`${item.type}-${item.id}-${index}`} item={item} />
      ))}
    </EmbedRow>
  );
}

/** Feed-card width (~300px), up to three across, two on a phone. */
export function EmbedRow({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <div
      data-type="civitaiEmbed"
      className={clsx(
        'my-4 grid gap-3',
        count === 1 && 'max-w-[300px] grid-cols-1',
        count === 2 && 'max-w-[612px] grid-cols-2',
        count >= 3 && 'max-w-[924px] grid-cols-2 sm:grid-cols-3'
      )}
    >
      {children}
    </div>
  );
}
