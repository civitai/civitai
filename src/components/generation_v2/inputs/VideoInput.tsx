/**
 * VideoInput
 *
 * A form input component for uploading/selecting a video with metadata.
 * Uses trpc to fetch video metadata (fps, dimensions, duration) when a video URL is provided.
 * Includes a dropzone for uploading new videos.
 * For videos already from orchestrator URLs, no re-upload is needed.
 *
 * Value format: { url: string, metadata?: VideoMetadata } | undefined
 */

import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Input,
  Loader,
  Text,
  TextInput,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import type { InputWrapperProps } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconUpload, IconVideo, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import type { DragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { isOrchestratorUrl, maxVideoFileSize } from '~/server/common/constants';
import { VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { TimeSpan } from '@civitai/client';
import { trpc } from '~/utils/trpc';
import { getVideoData } from '~/utils/media-preprocessors';
import { formatBytes } from '~/utils/number-helpers';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';

// =============================================================================
// Types
// =============================================================================

export type VideoMetadata = {
  fps: number;
  width: number;
  height: number;
  duration: number;
};

export type VideoValue = {
  url: string;
  metadata?: VideoMetadata;
};

export interface VideoInputProps extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: VideoValue;
  onChange?: (value: VideoValue | undefined) => void;
  /** Whether to show video dimensions overlay */
  showDimensions?: boolean;
  /** Maximum height for the video preview */
  maxHeight?: number;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Layout variant: 'default' (standard dropzone) or 'url-input' (text input + Choose button inside dropzone) */
  layout?: 'default' | 'url-input';
  /** Placeholder for URL text input (only used when layout='url-input') */
  urlPlaceholder?: string;
  /** Hint text below URL input (only used when layout='url-input') */
  urlHint?: string;
}

// =============================================================================
// Component
// =============================================================================

export function VideoInput({
  value,
  onChange,
  showDimensions = true,
  maxHeight = 300,
  label,
  description,
  error,
  required,
  disabled,
  layout = 'default',
  urlPlaceholder = 'Drop a video or provide a URL',
  urlHint,
  ...inputWrapperProps
}: VideoInputProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const videoUrl = value?.url;
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [videoDimensions, setVideoDimensions] = useState<{
    width: number;
    height: number;
  }>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlValue, setUrlValue] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  // Check if video is from orchestrator (uploaded successfully)
  const isFromOrchestrator = videoUrl ? isOrchestratorUrl(videoUrl) : false;

  // Fetch video metadata from server (fps, etc.) - only for orchestrator URLs
  const {
    data: serverMetadata,
    isLoading: isLoadingMetadata,
    error: metadataError,
  } = trpc.orchestrator.getVideoMetadata.useQuery(
    { videoUrl: videoUrl! },
    { enabled: isFromOrchestrator }
  );

  // Get video dimensions from the video element directly
  useEffect(() => {
    if (!videoUrl) {
      setVideoDimensions(undefined);
      setVideoLoadError(null);
      return;
    }

    // Clear previous error when URL changes
    setVideoLoadError(null);

    getVideoData(videoUrl).then((videoEl) => {
      if (videoEl) {
        setVideoDimensions({
          width: videoEl.videoWidth,
          height: videoEl.videoHeight,
        });
      }
    });
  }, [videoUrl]);

  // Update parent when metadata is loaded (only for orchestrator URLs)
  useEffect(() => {
    if (!isFromOrchestrator || !serverMetadata || !videoDimensions) return;

    const newMetadata: VideoMetadata = {
      fps: serverMetadata.fps,
      width: videoDimensions.width,
      height: videoDimensions.height,
      duration: serverMetadata.duration ? new TimeSpan(serverMetadata.duration as string).totalSeconds : 0,
    };

    // Only update if metadata changed
    if (
      value?.metadata?.fps !== newMetadata.fps ||
      value?.metadata?.width !== newMetadata.width ||
      value?.metadata?.height !== newMetadata.height ||
      value?.metadata?.duration !== newMetadata.duration
    ) {
      onChange?.({
        url: videoUrl!,
        metadata: newMetadata,
      });
    }
  }, [isFromOrchestrator, videoUrl, serverMetadata, videoDimensions, value?.metadata, onChange]);

  // Handle file drop - upload to orchestrator
  const handleDrop = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const file = files[0];

      // Check file size
      if (file.size > maxVideoFileSize) {
        setUploadError(`Video must be smaller than ${formatBytes(maxVideoFileSize)}`);
        return;
      }

      setIsUploading(true);
      setUploadError(null);

      try {
        // Upload directly to orchestrator using presigned URL
        const blob = await uploadConsumerBlob(file);

        if (blob.blockedReason || !blob.available || !blob.url) {
          throw new Error(blob.blockedReason ?? 'Video upload failed');
        }

        // Set the orchestrator URL - metadata will be fetched via trpc query
        onChange?.({
          url: blob.url,
          metadata: undefined,
        });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Failed to upload video');
      } finally {
        setIsUploading(false);
      }
    },
    [onChange]
  );

  // Handle remove video
  const handleRemove = useCallback(() => {
    onChange?.(undefined);
    setVideoDimensions(undefined);
    setUploadError(null);
    setVideoLoadError(null);
  }, [onChange]);

  // Handle video load error
  const handleVideoError = useCallback(() => {
    setVideoLoadError(
      'Failed to load video. The video may be unavailable or in an unsupported format.'
    );
  }, []);

  // URL-input layout handlers
  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) handleDrop(files);
    e.target.value = '';
  }

  function submitUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setUploadError(null);
    setUrlValue('');
    onChange?.({ url: trimmed, metadata: undefined });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitUrl(urlValue);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text/plain').trim();
    if (pasted.startsWith('http://') || pasted.startsWith('https://')) {
      e.preventDefault();
      submitUrl(pasted);
    }
  }

  function handleNativeDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!disabled && !isUploading) setIsDragOver(true);
  }

  function handleNativeDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }

  async function handleNativeDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled || isUploading) return;

    const url = e.dataTransfer.getData('text/uri-list');
    if (url?.length) {
      setUploadError(null);
      onChange?.({ url, metadata: undefined });
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await handleDrop(files);
  }

  const isLoading = isUploading;
  const isUrlInputLayout = layout === 'url-input';

  return (
    <Input.Wrapper
      {...inputWrapperProps}
      label={label}
      description={description}
      error={error}
      required={required}
    >
      {!videoUrl ? (
        isUrlInputLayout ? (
          // URL-input layout: text input + Choose button inside dashed drop target
          <div
            onDragOver={handleNativeDragOver}
            onDragLeave={handleNativeDragLeave}
            onDrop={handleNativeDrop}
            className={clsx(
              'rounded-md border border-dashed p-3',
              isDragOver
                ? 'border-blue-5 bg-blue-0 dark:border-blue-7 dark:bg-blue-9/20'
                : 'border-gray-4 dark:border-dark-4'
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={VIDEO_MIME_TYPE.join(',')}
              onChange={handleFileInputChange}
            />
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <TextInput
                  className="flex-1"
                  placeholder={urlPlaceholder}
                  value={urlValue}
                  onChange={(e) => setUrlValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  size="xs"
                  disabled={disabled || isUploading}
                  rightSection={isUploading ? <Loader size={14} /> : undefined}
                />
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || isUploading}
                >
                  Choose...
                </Button>
              </div>
              {urlHint && (
                <Text size="xs" c="dimmed">
                  {urlHint}
                </Text>
              )}
            </div>
          </div>
        ) : (
          // Default layout: Mantine Dropzone with icon + text
          <Dropzone
            onDrop={handleDrop}
            onDropCapture={async (e: DragEvent) => {
              const url = e.dataTransfer.getData('text/uri-list');
              if (url?.length) {
                setUploadError(null);
                onChange?.({ url, metadata: undefined });
              }
            }}
            accept={VIDEO_MIME_TYPE}
            maxFiles={1}
            disabled={disabled || isUploading}
            className="cursor-pointer"
          >
            <div className="flex flex-col items-center justify-center gap-2 py-8">
              {isUploading ? (
                <>
                  <Loader size={50} />
                  <Text size="sm" c="dimmed" ta="center">
                    Uploading video...
                  </Text>
                </>
              ) : (
                <>
                  <Dropzone.Accept>
                    <IconUpload
                      size={50}
                      stroke={1.5}
                      color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
                    />
                  </Dropzone.Accept>
                  <Dropzone.Reject>
                    <IconX
                      size={50}
                      stroke={1.5}
                      color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
                    />
                  </Dropzone.Reject>
                  <Dropzone.Idle>
                    <IconVideo size={50} stroke={1.5} />
                  </Dropzone.Idle>
                  <Text size="sm" c="dimmed" ta="center">
                    Drag a video here or click to select
                  </Text>
                  <Text size="xs" c="dimmed">
                    MP4, WebM supported (max {formatBytes(maxVideoFileSize)})
                  </Text>
                </>
              )}
            </div>
          </Dropzone>
        )
      ) : (
        // Video preview when a video is selected
        <Card withBorder padding={0} className="relative overflow-hidden">
          <EdgeVideo
            src={videoUrl}
            disableWebm
            disablePoster
            disablePictureInPicture
            playsInline
            controls
            options={{ anim: true }}
            style={{ maxHeight }}
            wrapperProps={{ className: 'w-full' }}
            onError={handleVideoError}
          />

          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Loader size="md" color="white" />
            </div>
          )}

          {/* Remove button */}
          <ActionIcon
            variant="filled"
            color="red"
            size="sm"
            radius="xl"
            className="absolute right-2 top-2"
            onClick={handleRemove}
            disabled={disabled}
          >
            <IconX size={14} />
          </ActionIcon>

          {/* Dimensions overlay */}
          {showDimensions && videoDimensions && (
            <div className="absolute bottom-0 right-0 rounded-br-md rounded-tl-md bg-dark-9/70 px-2 py-0.5 text-xs text-white">
              {videoDimensions.width} x {videoDimensions.height}
            </div>
          )}

          {/* FPS badge */}
          {serverMetadata?.fps && (
            <div className="absolute bottom-0 left-0 rounded-bl-md rounded-tr-md bg-dark-9/70 px-2 py-0.5 text-xs text-white">
              {serverMetadata.fps} FPS
            </div>
          )}

          {/* Orchestrator badge */}
          {isFromOrchestrator && (
            <div className="absolute left-2 top-2 rounded bg-blue-6/80 px-1.5 py-0.5 text-xs text-white">
              From Generation
            </div>
          )}
        </Card>
      )}

      {/* Error states */}
      {(metadataError || uploadError || videoLoadError) && (
        <Alert color="red" className="mt-2">
          {uploadError ??
            videoLoadError ??
            `Failed to load video metadata: ${metadataError?.message}`}
        </Alert>
      )}
    </Input.Wrapper>
  );
}
