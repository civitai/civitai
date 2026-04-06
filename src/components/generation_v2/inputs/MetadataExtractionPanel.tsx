/**
 * MetadataExtractionPanel
 *
 * Self-contained component for the img2meta workflow.
 * Includes a dropzone, metadata extraction, JSON display, and resource resolution.
 * Writes extraction results to the metadata-extraction store so FormFooter
 * can render remix/workflow action buttons.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ActionIcon,
  Button,
  Card,
  Checkbox,
  CloseButton,
  Code,
  CopyButton,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import {
  IconCheck,
  IconCopy,
  IconFileSearch,
  IconPhoto,
  IconPlus,
  IconUpload,
  IconX,
} from '@tabler/icons-react';

import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { useMetadataExtractionStore } from '~/store/metadata-extraction.store';
import { ExifParser } from '~/utils/metadata';
import { trpc } from '~/utils/trpc';
import { isAndroidDevice } from '~/utils/device-helpers';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { getEcosystem } from '~/shared/constants/basemodel.constants';
import { generationGraphStore, generationGraphPanel } from '~/store/generation-graph.store';
import { ResourceItemContent } from './ResourceItemContent';

/** Try to extract an image URL from a drop event (e.g. dragging an on-site image). */
function getDroppedImageUrl(event: React.DragEvent): string | undefined {
  // Prefer uri-list, fall back to plain text
  const uri =
    event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  if (!uri) return undefined;
  try {
    const url = new URL(uri);
    // Only allow http(s) URLs that look like images
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Try to extract a Civitai media database ID and type from the drop event's custom drag data.
 * EdgeImage/EdgeVideo
 * set 'application/x-civitai-media-id' and 'application/x-civitai-media-type'
 * when imageId is provided, allowing drop targets to fetch stored metadata server-side.
 */
function getDroppedMediaInfo(
  event: React.DragEvent
): { id: number; type: 'image' | 'video' } | undefined {
  const raw = event.dataTransfer.getData('application/x-civitai-media-id');
  if (!raw) return undefined;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) return undefined;
  const type = event.dataTransfer.getData('application/x-civitai-media-type');
  return { id, type: type === 'video' ? 'video' : 'image' };
}

/** Fetch a remote image and return it as a File. */
async function fetchImageAsFile(url: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const blob = await res.blob();
  const ext = blob.type.split('/')[1] ?? 'png';
  return new File([blob], `image.${ext}`, { type: blob.type });
}

export function MetadataExtractionPanel() {
  const theme = useMantineTheme();
  const [file, setFile] = useState<File>();
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  // When an on-site media is dropped, we extract its DB id and type to fetch metadata server-side
  const [droppedMedia, setDroppedMedia] = useState<{ id: number; type: 'image' | 'video' }>();
  // Selected resource IDs for multi-resource "Use selected" flow
  const [selectedResourceIds, setSelectedResourceIds] = useState<Set<number>>(new Set());

  const store = useMetadataExtractionStore();

  // Handle file drop — read locally only, no upload
  const handleDrop = useCallback(
    (files: File[]) => {
      setDroppedMedia(undefined);
      store.clear();
      setFile(files[0]);
    },
    [store]
  );

  // Handle drops that contain a URL instead of a file (e.g. dragging an on-site image)
  const handleUrlDrop = useCallback(
    async (event: React.DragEvent) => {
      // If the drop contains files, let the Dropzone handle it normally
      if (event.dataTransfer.files.length > 0) return;

      const url = getDroppedImageUrl(event);
      if (!url) return;

      event.preventDefault();
      event.stopPropagation();

      // Check if this is an on-site media with a known DB id
      const mediaInfo = getDroppedMediaInfo(event);

      store.clear();
      setFile(undefined);
      setDroppedMedia(undefined);
      setIsFetchingUrl(true);
      try {
        if (mediaInfo) {
          // On-site media: metadata comes from the server
          setDroppedMedia(mediaInfo);
          if (mediaInfo.type === 'video') {
            // Videos: use CDN URL directly for EdgeVideo preview
            store.setFileUrl(url);
          } else {
            // Images: fetch blob and convert to data URL for preview
            const res = await fetch(url);
            if (res.ok) {
              const blob = await res.blob();
              const reader = new FileReader();
              reader.onload = () => store.setFileUrl(reader.result as string);
              reader.readAsDataURL(blob);
            }
          }
        } else {
          // External image: fetch as file for EXIF extraction
          const imageFile = await fetchImageAsFile(url);
          setFile(imageFile);
        }
      } catch (e) {
        console.error('Failed to load dropped image URL:', e);
      } finally {
        setIsFetchingUrl(false);
      }
    },
    [store]
  );

  const handleClear = useCallback(() => {
    setFile(undefined);
    setDroppedMedia(undefined);
    setSelectedResourceIds(new Set());
    store.clear();
  }, [store]);

  /** Add one or more resources to the generation form */
  const handleAddResources = useCallback((resources: typeof store.resolvedResources) => {
    if (resources.length === 0) return;
    const checkpoint = resources.find((r) => r.model.type === 'Checkpoint') ?? resources[0];
    generationGraphStore.setData({
      params: { ecosystem: getEcosystem(checkpoint.baseModel)?.key },
      resources,
      runType: 'run',
    });
    generationGraphPanel.open();
  }, []);

  // Convert dropped file to a data URL (persists beyond component unmount for img2img use)
  // Skip when droppedMedia is set — fileUrl is set directly in handleUrlDrop for that path
  useEffect(() => {
    if (droppedMedia) return;
    if (!file) {
      store.setFileUrl(undefined);
      return;
    }
    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => {
      if (!cancelled) store.setFileUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Extract metadata when file changes (client-side EXIF path only)
  useEffect(() => {
    if (droppedMedia) return; // Server path handles metadata
    if (!file) {
      store.setMetadata(undefined);
      return;
    }
    // Skip EXIF extraction for video files — only images have extractable EXIF data
    if (file.type.startsWith('video/')) {
      store.setMetadata(undefined);
      return;
    }

    let cancelled = false;
    store.setIsExtracting(true);

    (async () => {
      try {
        const parser = await ExifParser(file);
        const { extra } = parser.parse() ?? {};
        const meta = { ...(await parser.getMetadata()), ...extra };
        delete meta.extra;
        if (!cancelled) store.setMetadata(meta);
      } catch (e) {
        console.error('Metadata extraction failed:', e);
        if (!cancelled) store.setMetadata(undefined);
      } finally {
        if (!cancelled) store.setIsExtracting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // --- Server-side path: fetch generation data by media ID (on-site drops) ---
  const { data: serverData, isFetching: isFetchingServerData } =
    trpc.generation.getGenerationData.useQuery(
      {
        type: droppedMedia?.type as 'image' | 'video',
        id: droppedMedia?.id as number,
        withPreview: true,
      },
      { enabled: !!droppedMedia, staleTime: 5 * 60 * 1000 }
    );

  // Sync server generation data into the store
  useEffect(() => {
    if (!serverData) return;
    const params = serverData.params as Record<string, unknown> | undefined;
    if (params && Object.keys(params).length > 0) {
      store.setMetadata(params as ImageMetaProps);
    }
    store.setResolved(serverData.resources, params ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverData, droppedMedia]);

  // --- Client-side path: resolve EXIF metadata via resolveImageMeta (external/local drops) ---
  const hasMetadataForQuery = !!store.metadata && Object.keys(store.metadata).length > 0;

  // Strip large fields (e.g. ComfyUI workflow graph) that aren't used server-side
  // but can blow past the HTTP header size limit for GET requests (431 error)
  const queryMetadata = useMemo(() => {
    if (!store.metadata) return {};
    const { ...metadata } = store.metadata;
    delete metadata.comfy;
    return metadata;
  }, [store.metadata]);

  const { data: resolved, isFetching } = trpc.generation.resolveImageMeta.useQuery(
    { metadata: queryMetadata },
    // Only run EXIF-based resolution when we don't have a server-side image ID
    { enabled: hasMetadataForQuery && !droppedMedia, staleTime: 5 * 60 * 1000 }
  );

  // Sync loading state to the store for FormFooter.
  const isResolving = droppedMedia ? isFetchingServerData : isFetching;
  useEffect(() => {
    store.setIsResolving(isResolving);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResolving]);

  useEffect(() => {
    // Only apply resolveImageMeta results when not using the server path
    if (droppedMedia) return;
    if (resolved) {
      store.setResolved(resolved.resources, resolved.params);
    } else {
      store.setResolved([], {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, droppedMedia]);

  const hasMetadata = hasMetadataForQuery;

  const meta = store.metadata;
  const prompt = meta?.prompt;
  const negativePrompt = meta?.negativePrompt;

  return (
    <Stack gap="sm">
      {/* Dropzone — always rendered so users can drop a new image even when one is loaded */}
      <div
        onDrop={handleUrlDrop}
        onDragOver={(e) => {
          // Allow drop so the event fires for URL-based drags
          if (
            e.dataTransfer.types.includes('application/x-civitai-media-id') ||
            e.dataTransfer.types.includes('text/uri-list') ||
            e.dataTransfer.types.includes('text/plain')
          ) {
            e.preventDefault();
          }
        }}
      >
        <Dropzone
          onDrop={handleDrop}
          accept={IMAGE_MIME_TYPE}
          maxFiles={1}
          maxSize={50 * 1024 ** 2}
          useFsAccessApi={!isAndroidDevice()}
        >
          {store.fileUrl ? (
            <div className="relative">
              {droppedMedia?.type === 'video' ? (
                <EdgeVideo
                  src={store.fileUrl}
                  controls
                  disableWebm
                  disablePoster
                  options={{ anim: true }}
                  style={{ maxHeight: 200 }}
                  wrapperProps={{ className: 'w-full rounded-md overflow-hidden' }}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={store.fileUrl}
                  alt="Dropped image"
                  className="max-h-[200px] w-full rounded-md object-contain"
                />
              )}
              <CloseButton
                className="absolute right-1 top-1 z-10"
                size="sm"
                variant="filled"
                color="dark"
                onClick={(e: any) => {
                  e.stopPropagation();
                  handleClear();
                }}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-8">
              <Dropzone.Accept>
                <IconUpload size={40} stroke={1.5} color={theme.colors[theme.primaryColor][6]} />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX size={40} stroke={1.5} color={theme.colors.red[6]} />
              </Dropzone.Reject>
              <Dropzone.Idle>
                {isFetchingUrl ? <Loader size={40} /> : <IconPhoto size={40} stroke={1.5} />}
              </Dropzone.Idle>
              <div>
                <Text size="sm" align="center">
                  {isFetchingUrl ? 'Loading image...' : 'Drop an image here or click to select'}
                </Text>
                <Text size="xs" c="dimmed" align="center" mt={4}>
                  Extract generation parameters from AI-generated images
                </Text>
              </div>
            </div>
          )}
        </Dropzone>
      </div>

      {/* Loading state */}
      {(store.isExtracting || (droppedMedia && isFetchingServerData)) && (
        <div className="flex items-center gap-2 py-2">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            {droppedMedia ? 'Loading generation data...' : 'Extracting metadata...'}
          </Text>
        </div>
      )}

      {/* No metadata found */}
      {(file || droppedMedia) && !store.isExtracting && !isResolving && !hasMetadata && (
        <Card withBorder p="md">
          <div className="flex items-center gap-2">
            <ThemeIcon variant="light" color="gray" size="lg">
              <IconFileSearch size={18} />
            </ThemeIcon>
            <Text c="dimmed" size="sm">
              No generation metadata found in this image.
            </Text>
          </div>
        </Card>
      )}

      {/* Metadata display */}
      {hasMetadata && (
        <>
          {/* Resolved resources — only show for client-side EXIF path */}
          {!droppedMedia && isFetching && (
            <div className="flex items-center gap-2 py-2">
              <Loader size="sm" />
              <Text c="dimmed" size="sm">
                Resolving resources...
              </Text>
            </div>
          )}
          {store.resolvedResources.length > 0 && (
            <Card withBorder p="sm">
              <Card.Section withBorder>
                <Group justify="space-between" className="px-3 py-2">
                  <Text fw={500} size="sm">
                    Resources ({store.resolvedResources.length})
                  </Text>
                  {store.resolvedResources.length > 1 && (
                    <Button
                      size="compact-xs"
                      variant="light"
                      leftSection={<IconPlus size={14} />}
                      disabled={selectedResourceIds.size === 0}
                      onClick={() => {
                        const selected = store.resolvedResources.filter((r) =>
                          selectedResourceIds.has(r.id)
                        );
                        handleAddResources(selected);
                      }}
                    >
                      Use selected
                    </Button>
                  )}
                </Group>
              </Card.Section>
              <Card.Section>
                <div className="p-3">
                  <Stack gap="xs">
                    {store.resolvedResources.map((resource) => (
                      <Group key={resource.id} gap="xs" wrap="nowrap" align="start">
                        {store.resolvedResources.length > 1 && (
                          <Checkbox
                            size="xs"
                            className="mt-1.5"
                            checked={selectedResourceIds.has(resource.id)}
                            onChange={(e) => {
                              const checked = e.currentTarget.checked;
                              setSelectedResourceIds((prev) => {
                                const next = new Set(prev);
                                if (checked) next.add(resource.id);
                                else next.delete(resource.id);
                                return next;
                              });
                            }}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <ResourceItemContent
                            resource={resource}
                            actions={
                              <Tooltip label="Add to generation">
                                <ActionIcon
                                  size="md"
                                  variant="subtle"
                                  onClick={() => handleAddResources([resource])}
                                >
                                  <IconPlus size={14} />
                                </ActionIcon>
                              </Tooltip>
                            }
                          />
                        </div>
                      </Group>
                    ))}
                  </Stack>
                </div>
              </Card.Section>
            </Card>
          )}

          {prompt && (
            <Card withBorder p="sm">
              <Card.Section withBorder>
                <div className="flex items-center justify-between px-3 py-2">
                  <Text fw={500} size="sm">
                    Prompt
                  </Text>
                  <CopyButton value={prompt}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                        <ActionIcon
                          variant="subtle"
                          color={copied ? 'teal' : 'gray'}
                          size="sm"
                          onClick={copy}
                        >
                          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                </div>
              </Card.Section>
              <Card.Section>
                <div className="p-3">
                  <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
                    {prompt}
                  </Text>
                </div>
              </Card.Section>
            </Card>
          )}
          {negativePrompt && (
            <Card withBorder p="sm">
              <Card.Section withBorder>
                <div className="flex items-center justify-between px-3 py-2">
                  <Text fw={500} size="sm">
                    Negative Prompt
                  </Text>
                  <CopyButton value={negativePrompt}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                        <ActionIcon
                          variant="subtle"
                          color={copied ? 'teal' : 'gray'}
                          size="sm"
                          onClick={copy}
                        >
                          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                </div>
              </Card.Section>
              <Card.Section>
                <div className="p-3">
                  <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
                    {negativePrompt}
                  </Text>
                </div>
              </Card.Section>
            </Card>
          )}

          {/* Raw metadata JSON */}
          <Card withBorder p="sm">
            <Card.Section withBorder>
              <div className="px-3 py-2">
                <Text fw={500} size="sm">
                  Extracted Metadata
                </Text>
              </div>
            </Card.Section>
            <Card.Section>
              <div className="p-3">
                <Code block className="max-h-[300px] overflow-auto text-xs">
                  {JSON.stringify(store.metadata, null, 2)}
                </Code>
              </div>
            </Card.Section>
          </Card>
        </>
      )}
    </Stack>
  );
}
