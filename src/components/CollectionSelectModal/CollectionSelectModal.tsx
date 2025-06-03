import {
  Badge,
  Center,
  CloseButton,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { IconCloudOff, IconLayoutGrid, IconUser } from '@tabler/icons-react';
import React, { useContext, useEffect, useRef } from 'react';
import type { InstantSearchProps } from 'react-instantsearch';
import { Configure, InstantSearch, useInstantSearch } from 'react-instantsearch';
import cardClasses from '~/components/Cards/Cards.module.css';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { searchIndexMap } from '~/components/Search/search.types';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import searchClasses from '~/components/Search/SearchLayout.module.scss';
import { env } from '~/env/client';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ImageCover, ImageSrcCover } from '~/components/Cards/CollectionCard';
import { FeedCard } from '~/components/Cards/FeedCard';
import { abbreviateNumber } from '~/utils/number-helpers';
import clsx from 'clsx';

const CollectionSelectContext = React.createContext<{
  onSelect: (collectionId: number) => void;
} | null>(null);

const useCollectionSelectContext = () => {
  const context = useContext(CollectionSelectContext);
  if (!context) throw new Error('missing CollectionSelectContext');
  return context;
};

export default function ModelShowcaseCollectionModal({
  username,
  onSelect,
  onClose,
}: CollectionSelectModalProps) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();

  const filters: string[] = ['type = Model', `user.username = ${username}`];

  function handleSelect(collectionId: number) {
    onSelect(collectionId);
    handleClose();
  }

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    <Modal {...dialog} onClose={handleClose} size={1200} withCloseButton={false} padding={0}>
      <div className="flex size-full max-h-full max-w-full flex-col overflow-hidden">
        <CollectionSelectContext.Provider value={{ onSelect: handleSelect }}>
          <InstantSearch
            searchClient={searchClient}
            indexName={searchIndexMap.collections}
            future={{ preserveSharedStateOnUnmount: true }}
          >
            <Configure hitsPerPage={20} filters={[...filters].join(' AND ')} />
            <div className="flex flex-col gap-3 p-3">
              <div className="flex items-center justify-between">
                <Text>Select Model Showcase Collection</Text>
                <CloseButton onClick={handleClose} />
              </div>
              <CustomSearchBox isMobile={!!isMobile} autoFocus />
            </div>
            <ResourceHitList />
          </InstantSearch>
        </CollectionSelectContext.Provider>
      </div>
    </Modal>
  );
}

export type CollectionSelectModalProps = {
  onSelect: (collectionId: number) => void;
  username: string;
  onClose?: () => void;
};

function HiddenNotice({ hiddenCount }: { hiddenCount: number }) {
  return (
    <Text c="dimmed">
      {hiddenCount} {hiddenCount > 1 ? 'collections have' : 'collection has'} been hidden due to
      your settings.
    </Text>
  );
}

function ResourceHitList() {
  const startedRef = useRef(false);
  const { status } = useInstantSearch();
  const { items, showMore, isLastPage } = useInfiniteHitsTransformed<'collections'>();
  const {
    items: collections,
    loadingPreferences,
    hiddenCount,
  } = useApplyHiddenPreferences({
    type: 'collections',
    data: items,
  });
  const loading =
    status === 'loading' || status === 'stalled' || loadingPreferences || !startedRef.current;

  useEffect(() => {
    if (!startedRef.current && status !== 'idle') startedRef.current = true;
  }, [status]);

  if (loading && !items.length)
    return (
      <div className="p-3 py-5">
        <Center mt="md">
          <Loader />
        </Center>
      </div>
    );

  if (!items.length)
    return (
      <div className="p-3 py-5">
        <Center>
          <Stack gap="md" align="center" maw={800}>
            {hiddenCount > 0 && <HiddenNotice hiddenCount={hiddenCount} />}
            <ThemeIcon size={128} radius={100} style={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} className="inline-block">
              No collections found
            </Title>
            <Text align="center">
              It looks like we couldn&rsquo;t find any matching your query.
            </Text>
          </Stack>
        </Center>
      </div>
    );

  return (
    <div className="flex flex-col gap-3 p-3">
      {hiddenCount > 0 && <HiddenNotice hiddenCount={hiddenCount} />}

      <div className={searchClasses.grid}>
        {collections.map((collection) => (
          <CollectionSelectCard key={collection.id} data={collection} />
        ))}
      </div>
      {items.length > 0 && !isLastPage && (
        <InViewLoader loadFn={showMore} loadCondition={status === 'idle'}>
          <Center style={{ height: 36 }} my="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </div>
  );
}

function CollectionSelectCard({ data }: { data: SearchIndexDataMap['collections'][number] }) {
  const { onSelect } = useCollectionSelectContext();

  const handleSelect = () => {
    onSelect(data.id);
  };

  const getCoverImages = () => {
    if (data.image) return [data.image];
    if (data.images) return data.images ?? [];
    return [];
  };

  const getCoverSrcs = () => {
    if (data.image) return [];
    if (data.srcs) return data.srcs ?? [];
    return [];
  };

  const coverImages = getCoverImages();
  const coverSrcs: string[] = getCoverSrcs();
  const isMultiImage = coverImages.length !== 0 ? coverImages.length > 1 : coverSrcs.length > 1;
  const coverImagesCount = coverImages.length || coverSrcs.length;
  const contributorCount = data.metrics?.contributorCount || 0;
  const itemCount = data.metrics?.itemCount || 0;

  return (
    <FeedCard
      className={coverImages.length === 0 ? cardClasses.noImage : undefined}
      onClick={handleSelect}
      aspectRatio="portrait"
    >
      <div
        className={clsx({
          [cardClasses.root]: true,
          [cardClasses.noHover]: isMultiImage,
        })}
      >
        <div
          className={
            isMultiImage
              ? clsx({
                  [cardClasses.imageGroupContainer]: true,
                  [cardClasses.imageGroupContainer4x4]: coverImagesCount > 2,
                })
              : cardClasses.imageGroupContainer
          }
        >
          {coverImages.length > 0 ? (
            <ImageCover data={data} coverImages={coverImages.slice(0, 4)} />
          ) : coverSrcs.length > 0 ? (
            <ImageSrcCover data={data} coverSrcs={coverSrcs} />
          ) : (
            <Center h="100%">
              <Text c="dimmed">This collection has no images</Text>
            </Center>
          )}
        </div>

        <div
          className={clsx('flex flex-col gap-2', cardClasses.contentOverlay, cardClasses.bottom)}
        >
          <Text className={cardClasses.dropShadow} size="xl" fw={700} lineClamp={2} lh={1.2}>
            {data.name}
          </Text>
          <div className="flex flex-nowrap gap-1">
            <Badge
              className={clsx(cardClasses.statChip, cardClasses.chip)}
              classNames={{ label: 'flex flex-nowrap gap-2' }}
              variant="light"
              radius="xl"
            >
              <Group gap={2}>
                <IconLayoutGrid size={14} stroke={2.5} />
                <Text fw="bold" size="xs">
                  {abbreviateNumber(itemCount)}
                </Text>
              </Group>
              <Group gap={2}>
                <IconUser size={14} stroke={2.5} />
                <Text fw="bold" size="xs">
                  {abbreviateNumber(contributorCount)}
                </Text>
              </Group>
            </Badge>
          </div>
        </div>
      </div>
    </FeedCard>
  );
}

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    return meilisearch.search(requests);
  },
};
