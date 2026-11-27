import { Button, Center, Loader, SegmentedControl, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useQueryArticles } from '~/components/Article/article.utils';
import { useQueryImages } from '~/components/Image/image.utils';
import { useQueryModels } from '~/components/Model/model.utils';
import { ArticleSort, ImageSort, ModelSort } from '~/server/common/enums';
import type { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';

type Kind = 'Image' | 'Model' | 'Article';

const kindLabels: Record<Kind, string> = {
  Image: 'Your images',
  Model: 'Your models',
  Article: 'Your articles',
};
type Tile = { entityType: Kind; entityId: number; url?: string; type?: MediaType; name?: string };

/**
 * The owner's own images, models and (where offered) articles, newest first, to add to or take off
 * a list with one tap each. Full at the limit: the rest are disabled, never swapped in for an
 * older item.
 */
export function ShowcaseOwnItemsPicker({
  userId,
  username,
  selected,
  limit,
  onToggle,
  kinds = ['Image', 'Model'],
  fullMessage = `Your showcase is full (${limit}). Remove an item above to add another.`,
}: {
  userId: number;
  username: string;
  selected: ShowcaseItemSchema[];
  limit: number;
  onToggle: (item: ShowcaseItemSchema) => void;
  kinds?: Kind[];
  fullMessage?: string;
}) {
  const [kind, setKind] = useState<Kind>(kinds[0]);
  const images = useQueryImages(
    {
      userId,
      sort: ImageSort.Newest,
      period: MetricTimeframe.AllTime,
      limit: 24,
      withMeta: false,
      notPublished: false,
    },
    { enabled: kind === 'Image', applyHiddenPreferences: false }
  );
  const models = useQueryModels(
    { username, sort: ModelSort.Newest, period: MetricTimeframe.AllTime, limit: 24 },
    { enabled: kind === 'Model' }
  );
  const articles = useQueryArticles(
    { username, sort: ArticleSort.Newest, period: MetricTimeframe.AllTime, limit: 24 },
    { enabled: kind === 'Article', applyHiddenPreferences: false }
  );

  const query = kind === 'Image' ? images : kind === 'Model' ? models : articles;
  const tiles: Tile[] =
    kind === 'Article'
      ? articles.articles.map((article) => ({
          entityType: 'Article',
          entityId: article.id,
          url: article.coverImage?.url,
          type: article.coverImage?.type as MediaType | undefined,
          name: article.title,
        }))
      : kind === 'Image'
      ? images.images.map((image) => ({
          entityType: 'Image',
          entityId: image.id,
          url: image.url,
          type: image.type as MediaType,
        }))
      : models.models.map((model) => ({
          entityType: 'Model',
          entityId: model.id,
          url: model.images?.[0]?.url,
          type: model.images?.[0]?.type as MediaType | undefined,
          name: model.name,
        }));

  const isSelected = (tile: Tile) =>
    selected.some((item) => item.entityType === tile.entityType && item.entityId === tile.entityId);
  const full = selected.length >= limit;

  return (
    <Stack gap="xs">
      {kinds.length > 1 && (
        <SegmentedControl
          size="xs"
          value={kind}
          onChange={(value) => setKind(value as Kind)}
          data={kinds.map((value) => ({ value, label: kindLabels[value] }))}
        />
      )}
      {full && (
        <Text size="xs" c="dimmed">
          {fullMessage}
        </Text>
      )}
      {query.isLoading ? (
        <Center py="md">
          <Loader size="sm" />
        </Center>
      ) : tiles.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          {kind === 'Image'
            ? 'You have no published images yet.'
            : kind === 'Model'
            ? 'You have no models yet.'
            : 'You have no articles yet.'}
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 3, sm: 6 }} spacing={6}>
          {tiles.map((tile) => {
            const chosen = isSelected(tile);
            const disabled = !chosen && full;
            return (
              <button
                key={`${tile.entityType}-${tile.entityId}`}
                type="button"
                disabled={disabled}
                onClick={() => onToggle({ entityType: tile.entityType, entityId: tile.entityId })}
                aria-pressed={chosen}
                aria-label={
                  (chosen ? 'Remove from showcase: ' : 'Add to showcase: ') +
                  (tile.name ?? `${tile.entityType.toLowerCase()} ${tile.entityId}`)
                }
                className={clsx(
                  'relative aspect-square overflow-hidden rounded-md border-2 bg-gray-2 dark:bg-dark-5',
                  chosen ? 'border-blue-5' : 'border-transparent',
                  disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:opacity-90'
                )}
              >
                {tile.url && (
                  <EdgeMedia
                    src={tile.url}
                    type={tile.type ?? MediaType.image}
                    width={200}
                    className="size-full object-cover"
                    anim={false}
                  />
                )}
                {tile.name && (
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-left text-[10px] text-white">
                    {tile.name}
                  </span>
                )}
                {chosen && (
                  <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-blue-6 text-white">
                    <IconCheck size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </SimpleGrid>
      )}
      {query.hasNextPage && (
        <Button
          variant="subtle"
          size="compact-sm"
          onClick={() => query.fetchNextPage()}
          loading={query.isFetchingNextPage}
          className="self-center"
        >
          Show more
        </Button>
      )}
    </Stack>
  );
}
