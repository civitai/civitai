import {
  Button,
  Center,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhotoSearch, IconPhotoUp } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { ImagesCardMemoized } from '~/components/Image/Infinite/ImagesCard';
import { adjustImagesCardHeight } from '~/components/Image/Infinite/images-card-footer';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import {
  SEARCH_UPLOAD_ACCEPT,
  takePendingSearchUpload,
} from '~/components/Search/ImageSearchUpload/pending-search-upload';
import { useImageSearchUpload } from '~/components/Search/ImageSearchUpload/useImageSearchUpload';
import { CONSUMER_BLOB_MAX_UPLOAD_BYTES } from '~/utils/consumer-blob-upload';
import {
  searchUploadSourceSchema,
  type SearchUploadSource,
} from '~/server/schema/semantic-image-search.schema';
import { trpc } from '~/utils/trpc';

const SOURCE_KINDS = [
  { value: 'image', label: 'Image' },
  { value: 'post', label: 'Post' },
  { value: 'modelVersion', label: 'Model version' },
  { value: 'case', label: 'Case' },
];

function parseSource(kind: string | null, id: string): SearchUploadSource | undefined {
  const raw = id.trim();
  const parsed = searchUploadSourceSchema.safeParse({
    kind,
    id: kind === 'case' ? raw.toUpperCase() : Number(raw),
  });
  return parsed.success ? parsed.data : undefined;
}

export function ImageSearchUpload() {
  const upload = useImageSearchUpload();
  const { start } = upload;
  const [sourceKind, setSourceKind] = useState<string | null>('image');
  const [sourceId, setSourceId] = useState('');
  const source = parseSource(sourceKind, sourceId);
  // A file dropped on the search bar waits here until the item it starts from is filled in.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const took = useRef(false);
  useEffect(() => {
    if (took.current) return;
    took.current = true;
    setPendingFile(takePendingSearchUpload());
  }, []);

  const busy = upload.uploading || upload.checking;
  return (
    <Stack gap="md">
      <Group gap="sm" align="flex-end">
        <Select
          label="Started from"
          data={SOURCE_KINDS}
          value={sourceKind}
          onChange={setSourceKind}
          allowDeselect={false}
          w={160}
        />
        <TextInput
          label={sourceKind === 'case' ? 'Case reference' : 'ID'}
          value={sourceId}
          onChange={(e) => setSourceId(e.currentTarget.value)}
          error={sourceId.trim() && !source ? 'Enter a valid ID' : undefined}
          w={220}
        />
      </Group>
      {pendingFile && (
        <Group gap="sm">
          <Text size="sm">Enter the item you started from, then search with your image.</Text>
          <Button
            size="compact-sm"
            disabled={!source || busy}
            onClick={() => {
              if (!source) return;
              setPendingFile(null);
              void start(pendingFile, source);
            }}
          >
            Search
          </Button>
        </Group>
      )}
      <Dropzone
        onDrop={([file]) => file && source && void start(file, source)}
        accept={SEARCH_UPLOAD_ACCEPT}
        maxSize={CONSUMER_BLOB_MAX_UPLOAD_BYTES}
        maxFiles={1}
        multiple={false}
        loading={busy}
        disabled={busy || !source}
      >
        <Group justify="center" gap="md" mih={120} className="pointer-events-none">
          <IconPhotoUp size={40} stroke={1.5} />
          <div>
            <Text size="lg">Drop an image here, or click to pick one</Text>
            <Text size="sm" c="dimmed">
              JPEG, PNG or WebP. Your image is checked before it is searched and is never shown to
              anyone.
            </Text>
          </div>
        </Group>
      </Dropzone>
      {upload.uploading && <Status text="Uploading…" />}
      {upload.checking && <Status text="Checking your image…" />}
      {upload.error && (
        <Group gap="xs">
          <Text c="red">{upload.error}</Text>
          <Button size="compact-xs" variant="subtle" onClick={upload.reset}>
            Try another image
          </Button>
        </Group>
      )}
      {upload.ready ? (
        <UploadResults uploadId={upload.ready.uploadId} url={upload.ready.url} />
      ) : (
        !busy &&
        !upload.error && (
          <Center mt="md">
            <Stack gap="md" align="center" maw={600}>
              <ThemeIcon size={128} radius={100} className="opacity-50">
                <IconPhotoSearch size={80} />
              </ThemeIcon>
              <Title order={1} lh={1} ta="center">
                Search by image
              </Title>
              <Text align="center">Find images on Civitai that look like one you have.</Text>
            </Stack>
          </Center>
        )
      )}
    </Stack>
  );
}

function Status({ text }: { text: string }) {
  return (
    <Group gap="xs">
      <Loader size="sm" />
      <Text size="sm">{text}</Text>
    </Group>
  );
}

function UploadResults({ uploadId, url }: { uploadId: string; url: string }) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, isFetching, hasNextPage, fetchNextPage, error } =
    trpc.imageSearchUpload.search.useInfiniteQuery(
      { uploadId, uploadUrl: url, browsingLevel },
      { getNextPageParam: (page) => page.nextCursor, gcTime: 0, staleTime: 0 }
    );
  const items = (data?.pages ?? []).flatMap((page) => page.items);

  if (isLoading) return <Status text="Searching…" />;
  if (error) return <Text c="red">{error.message}</Text>;
  if (!items.length)
    return (
      <Text align="center" mt="md">
        We couldn&rsquo;t find images like this one.
      </Text>
    );
  return (
    <Stack>
      <ImagesProvider images={items as never}>
        <MasonryColumnsVirtual
          data={items as never[]}
          imageDimensions={(item: { width?: number | null; height?: number | null }) => ({
            width: item?.width ?? 450,
            height: item?.height ?? 450,
          })}
          adjustHeight={(args) => adjustImagesCardHeight(args)}
          maxItemHeight={600}
          render={ImagesCardMemoized}
          itemId={(item: { id: number }) => item.id}
        />
      </ImagesProvider>
      {hasNextPage ? (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetching}>
          <Center p="xl" style={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      ) : (
        <EndOfFeed text="That's every close match" />
      )}
    </Stack>
  );
}
