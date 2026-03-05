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
  Card,
  CloseButton,
  Code,
  CopyButton,
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
  IconUpload,
  IconX,
} from '@tabler/icons-react';

import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { useMetadataExtractionStore } from '~/store/metadata-extraction.store';
import { ExifParser } from '~/utils/metadata';
import { trpc } from '~/utils/trpc';
import { isAndroidDevice } from '~/utils/device-helpers';
import { ResourceItemContent } from './ResourceItemContent';

export function MetadataExtractionPanel() {
  const theme = useMantineTheme();
  const [file, setFile] = useState<File>();

  const store = useMetadataExtractionStore();

  // Handle file drop — read locally only, no upload
  const handleDrop = useCallback((files: File[]) => {
    setFile(files[0]);
  }, []);

  const handleClear = useCallback(() => {
    setFile(undefined);
    store.clear();
  }, [store]);

  // Convert dropped file to a data URL (persists beyond component unmount for img2img use)
  useEffect(() => {
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

  // Extract metadata when file changes
  useEffect(() => {
    if (!file) {
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

  // Resolve resources + transform metadata to graph params on the server
  const hasMetadataForQuery = !!store.metadata && Object.keys(store.metadata).length > 0;

  // Strip large fields (e.g. ComfyUI workflow graph) that aren't used server-side
  // but can blow past the HTTP header size limit for GET requests (431 error)
  const queryMetadata = useMemo(() => {
    if (!store.metadata) return {};
    const { ...metadata } = store.metadata;
    delete metadata.comfy;
    return metadata;
  }, [store.metadata]);

  const {
    data: resolved,
    isLoading: isResolvingResources,
    isFetching,
  } = trpc.generation.resolveImageMeta.useQuery(
    { metadata: queryMetadata },
    { enabled: hasMetadataForQuery, staleTime: 5 * 60 * 1000 }
  );

  // Sync loading state to the store for FormFooter.
  // Use isFetching (only true when request is in-flight), not isLoading
  // (which is true even when the query is disabled with no cached data).
  useEffect(() => {
    store.setIsResolving(isFetching);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFetching]);

  useEffect(() => {
    if (resolved) {
      store.setResolved(resolved.resources, resolved.params);
    } else {
      store.setResolved([], {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  const hasMetadata = hasMetadataForQuery;

  const meta = store.metadata;
  const prompt = meta?.prompt;
  const negativePrompt = meta?.negativePrompt;

  return (
    <Stack gap="sm">
      {/* Image preview or dropzone */}
      {store.fileUrl ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={store.fileUrl}
            alt="Dropped image"
            className="max-h-[200px] w-full rounded-md object-contain"
          />
          <CloseButton
            className="absolute right-1 top-1"
            size="sm"
            variant="filled"
            color="dark"
            onClick={handleClear}
          />
        </div>
      ) : (
        <Dropzone
          onDrop={handleDrop}
          accept={IMAGE_MIME_TYPE}
          maxFiles={1}
          maxSize={50 * 1024 ** 2}
          useFsAccessApi={!isAndroidDevice()}
        >
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <Dropzone.Accept>
              <IconUpload size={40} stroke={1.5} color={theme.colors[theme.primaryColor][6]} />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconX size={40} stroke={1.5} color={theme.colors.red[6]} />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconPhoto size={40} stroke={1.5} />
            </Dropzone.Idle>
            <div>
              <Text size="sm" align="center">
                Drop an image here or click to select
              </Text>
              <Text size="xs" c="dimmed" align="center" mt={4}>
                Extract generation parameters from AI-generated images
              </Text>
            </div>
          </div>
        </Dropzone>
      )}

      {/* Loading state */}
      {store.isExtracting && (
        <div className="flex items-center gap-2 py-2">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Extracting metadata...
          </Text>
        </div>
      )}

      {/* No metadata found */}
      {file && !store.isExtracting && !hasMetadata && (
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
          {/* Resolved resources */}
          {isResolvingResources && (
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
                <div className="px-3 py-2">
                  <Text fw={500} size="sm">
                    Resources ({store.resolvedResources.length})
                  </Text>
                </div>
              </Card.Section>
              <Card.Section>
                <div className="p-3">
                  <Stack gap="xs">
                    {store.resolvedResources.map((resource) => (
                      <ResourceItemContent key={resource.id} resource={resource} />
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
