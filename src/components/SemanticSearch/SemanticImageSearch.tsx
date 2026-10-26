import { Alert, Button, Center, Loader, MultiSelect, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImagesCardMemoized } from '~/components/Image/Infinite/ImagesCard';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import type { FeedbackRating } from '~/components/SemanticSearch/SemanticSearchFeedback';
import { SemanticSearchFeedback } from '~/components/SemanticSearch/SemanticSearchFeedback';
import type { PickedTag } from '~/components/SemanticSearch/TagMultiPicker';
import { TagMultiPicker } from '~/components/SemanticSearch/TagMultiPicker';
import { SEMANTIC_QUERY_MAX_LENGTH } from '~/server/schema/semantic-image-search.schema';
import { baseModelSelectData } from '~/shared/constants/basemodel.constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function SemanticImageSearch() {
  const router = useRouter();
  const query = typeof router.query.q === 'string' ? router.query.q : undefined;
  const imageIdParam = Number(router.query.imageId);
  const imageId = Number.isInteger(imageIdParam) && imageIdParam > 0 ? imageIdParam : undefined;

  const [text, setText] = useState(query ?? '');
  useEffect(() => setText(query ?? ''), [query]);
  const [tags, setTags] = useState<PickedTag[]>([]);
  const [excludedTags, setExcludedTags] = useState<PickedTag[]>([]);
  const [baseModels, setBaseModels] = useState<string[]>([]);
  const [types, setTypes] = useState<MediaType[]>([]);
  const browsingLevel = useBrowsingLevelDebounced();

  const input = {
    query: imageId ? undefined : query,
    imageId,
    browsingLevel,
    tagIds: tags.map((t) => t.id),
    excludedTagIds: excludedTags.map((t) => t.id),
    baseModels,
    types,
  };
  const enabled = !!input.query || !!input.imageId;
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetching } =
    trpc.semanticImageSearch.search.useInfiniteQuery(input, {
      enabled,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      retry: false,
    });
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const latencyMs = data?.pages[0]?.latencyMs;

  const searchKey = JSON.stringify(input);
  const [feedbackSentFor, setFeedbackSentFor] = useState<string>();
  const feedbackMutation = trpc.semanticImageSearch.feedback.useMutation({
    onSuccess: () => setFeedbackSentFor(searchKey),
    onError: (e) => showErrorNotification({ title: 'Feedback not saved', error: e }),
  });
  const handleFeedback = ({ rating, comment }: { rating: FeedbackRating; comment?: string }) =>
    feedbackMutation.mutate({
      rating,
      comment,
      query: input.query,
      imageId,
      filters: JSON.stringify({
        tagIds: input.tagIds,
        excludedTagIds: input.excludedTagIds,
        baseModels,
        types,
        browsingLevel,
      }),
      resultCount: items.length,
      latencyMs,
    });

  const submit = () => {
    const q = text.trim();
    if (!q) return;
    router.push({ pathname: '/search/semantic', query: { q } }, undefined, { shallow: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Title order={1}>Semantic image search</Title>
        <Text size="sm" c="dimmed">
          Describe what you want to see. Testing only: results and ranking will change.
        </Text>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextInput
          className="flex-1"
          placeholder="a red fox in the snow, watercolor"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          maxLength={SEMANTIC_QUERY_MAX_LENGTH}
          leftSection={<IconSearch size={16} />}
        />
        <Button type="submit">Search</Button>
      </form>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TagMultiPicker label="With tags" placeholder="Any tags" value={tags} onChange={setTags} />
        <TagMultiPicker
          label="Without tags"
          placeholder="No exclusions"
          value={excludedTags}
          onChange={setExcludedTags}
        />
        <MultiSelect
          label="Base model"
          placeholder="All base models"
          data={baseModelSelectData}
          value={baseModels}
          onChange={setBaseModels}
          searchable
          clearable
        />
        <MultiSelect
          label="Media type"
          placeholder="All types"
          data={[MediaType.image, MediaType.video]}
          value={types}
          onChange={(v) => setTypes(v as MediaType[])}
          clearable
        />
      </div>

      {imageId && !isError && (
        <Alert color="blue">
          Showing images similar to{' '}
          <Link href={`/images/${imageId}`} className="underline">
            image {imageId}
          </Link>
          .
        </Alert>
      )}

      {enabled && !isLoading && !isError && (
        <SemanticSearchFeedback
          key={searchKey}
          onSubmit={handleFeedback}
          submitting={feedbackMutation.isPending}
          submitted={feedbackSentFor === searchKey}
        />
      )}

      {!enabled ? (
        <NoContent message="Enter a query to search images by meaning." />
      ) : isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : isError ? (
        <Alert color="red" title="Search failed">
          {error.data?.code === 'NOT_FOUND' || error.data?.code === 'TOO_MANY_REQUESTS'
            ? error.message
            : 'Search is unavailable right now, try again.'}
        </Alert>
      ) : !items.length ? (
        <NoContent message="No images matched. Try other words or fewer filters." />
      ) : (
        <div className="relative">
          <ImagesProvider images={items}>
            <MasonryColumnsVirtual
              data={items}
              imageDimensions={(d) => ({ width: d?.width ?? 450, height: d?.height ?? 450 })}
              adjustHeight={({ height }) => Math.max(Math.min(height, 600), 150) + 38}
              maxItemHeight={600}
              render={ImagesCardMemoized}
              itemId={(d) => d.id}
            />
          </ImagesProvider>
          {hasNextPage && (
            <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetching}>
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
        </div>
      )}
    </div>
  );
}
