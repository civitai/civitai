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
  Card,
  Input,
  Loader,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import type { InputWrapperProps } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconUpload, IconVideo, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { isOrchestratorUrl, maxVideoFileSize } from '~/server/common/constants';
import { VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { trpc } from '~/utils/trpc';
import { getVideoData } from '~/utils/media-preprocessors';
import { getBase64 } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';
import type { Blob as OrchestratorBlob } from '@civitai/client';

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
  ...inputWrapperProps
}: VideoInputProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const videoUrl = value?.url;
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [videoDimensions, setVideoDimensions] = useState<{
    width: number;
    height: number;
  }>();

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
      return;
    }

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
      duration: Number(serverMetadata.duration) || 0,
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
        // Convert to base64 for upload
        const base64 = await getBase64(file);

        // Upload to orchestrator using the same endpoint as images
        const response = await fetch('/api/orchestrator/uploadImage', {
          method: 'POST',
          body: base64,
        });

        if (!response.ok) {
          if (response.status === 403) {
            throw new Error(await response.text());
          } else {
            throw new Error(response.statusText);
          }
        }

        const blob: OrchestratorBlob = await response.json();

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
  }, [onChange]);

  const isLoading = isLoadingMetadata || isUploading || (videoUrl && !videoDimensions);

  return (
    <Input.Wrapper
      {...inputWrapperProps}
      label={label}
      description={description}
      error={error}
      required={required}
    >
      {!videoUrl ? (
        // Dropzone when no video is selected
        <Dropzone
          onDrop={handleDrop}
          accept={VIDEO_MIME_TYPE}
          maxFiles={1}
          disabled={disabled}
          className="cursor-pointer"
        >
          <div className="flex flex-col items-center justify-center gap-2 py-8">
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
              MP4, WebM, MOV supported (max {formatBytes(maxVideoFileSize)})
            </Text>
          </div>
        </Dropzone>
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
      {(metadataError || uploadError) && (
        <Alert color="red" className="mt-2">
          {uploadError ?? `Failed to load video metadata: ${metadataError?.message}`}
        </Alert>
      )}
    </Input.Wrapper>
  );
}
