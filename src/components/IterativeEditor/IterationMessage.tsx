import { Button, Loader, Text, Tooltip } from '@mantine/core';
import {
  IconBolt,
  IconCheck,
  IconExternalLink,
  IconEyeOff,
  IconLock,
  IconPencil,
  IconPlayerStop,
  IconRefresh,
  IconWand,
  IconZoomIn,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { IterationEntry, SourceImage } from './iterative-editor.types';
import styles from './IterativeImageEditor.module.scss';

interface IterationMessageProps {
  iteration: IterationEntry;
  isCurrentSource: boolean;
  onUseAsSource: () => void;
  onSelectImage?: (image: SourceImage) => void;
  onRetry?: () => void;
  /** When set, the generating iteration shows an "Abort" control. */
  onAbort?: () => void;
  onZoomImage?: (url: string) => void;
  /**
   * Returns true when the given image should be blurred for the current user
   * per their `blurLevels` preference. Blurred images cannot be used as
   * source on this domain — they must be unlocked on civitai.red.
   */
  isImageBlurred?: (image: SourceImage) => boolean;
  /**
   * Handoff URL to civitai.red for this iteration's workflow. Used both for
   * the `siteRestricted` status and for any blurred result image — clicking
   * it lands the user on the red-side iterative editor with the same
   * workflow context, where mature content is allowed.
   */
  unlockOnRedUrl?: string | null;
}

export function IterationMessage({
  iteration,
  isCurrentSource,
  onUseAsSource,
  onSelectImage,
  onRetry,
  onAbort,
  onZoomImage,
  isImageBlurred,
  unlockOnRedUrl,
}: IterationMessageProps) {
  const hasMultipleImages = iteration.resultImages.length > 1;
  const selectedUrl = iteration.resultImage?.url;

  const imageUrl = iteration.resultImage
    ? getEdgeUrl(iteration.resultImage.previewUrl, { width: 400 }) ??
      iteration.resultImage.previewUrl
    : null;

  const selectedBlurred =
    !!iteration.resultImage && !!isImageBlurred?.(iteration.resultImage);

  return (
    <div
      className={clsx(
        styles.iterationMessage,
        isCurrentSource && styles.currentSourceHighlight
      )}
    >
      {/* Prompt text */}
      <div className={styles.iterationPrompt}>{iteration.prompt || '(no prompt)'}</div>

      {/* Enhanced prompt (when AI enhancement was used) */}
      {iteration.enhancedPrompt && (
        <div className={styles.enhancedPrompt}>
          <div className={styles.enhancedPromptHeader}>
            <IconWand size={12} />
            Enhanced
          </div>
          <div className={styles.enhancedPromptText}>{iteration.enhancedPrompt}</div>
        </div>
      )}

      {/* Result image or loading/error state */}
      {iteration.status === 'generating' ? (
        <div className={styles.generatingSkeleton}>
          <div className={styles.generatingContent}>
            <Loader size="sm" color="yellow" />
            <Text size="xs" c="dimmed" className={styles.generatingText}>
              Generating...
            </Text>
            {onAbort && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconPlayerStop size={12} />}
                onClick={onAbort}
              >
                Stop waiting
              </Button>
            )}
          </div>
        </div>
      ) : iteration.status === 'error' ? (
        <div className={styles.errorBox}>
          <span>{iteration.errorMessage || 'Generation failed. Buzz has been refunded.'}</span>
          {onRetry && (
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              leftSection={<IconRefresh size={12} />}
              onClick={onRetry}
              mt={4}
            >
              Retry
            </Button>
          )}
        </div>
      ) : iteration.status === 'siteRestricted' ? (
        <div className={styles.siteRestrictedBox}>
          <IconEyeOff size={20} />
          <Text size="xs" fw={600} c="yellow">
            Mature Content
          </Text>
          <Text size="xs" c="dimmed" ta="center">
            This image was rated mature and cannot be viewed on this site. Your Buzz still
            paid for it — open it on civitai.red to add it to your panel.
          </Text>
          {unlockOnRedUrl && (
            <Button
              component="a"
              href={unlockOnRedUrl}
              target="_blank"
              rel="noopener noreferrer"
              size="compact-sm"
              variant="light"
              color="red"
              leftSection={<IconExternalLink size={12} />}
              mt={4}
            >
              Unlock on civitai.red
            </Button>
          )}
        </div>
      ) : hasMultipleImages ? (
        // Multi-image grid: show all results, highlight selected
        <div className={styles.multiImageGrid}>
          {iteration.resultImages.map((img, idx) => {
            const thumbUrl =
              getEdgeUrl(img.previewUrl, { width: 200 }) ?? img.previewUrl;
            const isSelected = img.url === selectedUrl;
            const blurred = !!isImageBlurred?.(img);
            return (
              <button
                key={idx}
                className={clsx(
                  styles.multiImageThumb,
                  isSelected && styles.multiImageThumbSelected,
                  blurred && styles.multiImageThumbBlurred
                )}
                onClick={() => onSelectImage?.(img)}
                type="button"
              >
                <img
                  src={thumbUrl}
                  alt={`Option ${idx + 1}`}
                  className={blurred ? styles.blurredImage : undefined}
                />
                {blurred && (
                  // The whole overlay is the trigger: click anywhere in the
                  // thumb to land on civitai.red with this workflow's context.
                  // We render a non-link container and an inner anchor so the
                  // button styling stays consistent with everything else; the
                  // anchor stops propagation to avoid double-firing the
                  // parent's `onSelectImage`.
                  <div
                    className={styles.unlockOverlay}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconLock size={16} />
                    <Text size="xs" fw={600}>
                      Mature
                    </Text>
                    {unlockOnRedUrl ? (
                      <Button
                        component="a"
                        href={unlockOnRedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        size="compact-xs"
                        variant="light"
                        color="red"
                        leftSection={<IconExternalLink size={10} />}
                      >
                        Unlock on red
                      </Button>
                    ) : (
                      <Text size="xs" c="dimmed">
                        Mature content
                      </Text>
                    )}
                  </div>
                )}
                {!blurred && isSelected && (
                  <div className={styles.multiImageCheck}>
                    <IconCheck size={14} />
                  </div>
                )}
                {!blurred && onZoomImage && (
                  <button
                    type="button"
                    className={styles.zoomButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      onZoomImage(getEdgeUrl(img.previewUrl, { width: 1200 }) ?? img.previewUrl);
                    }}
                  >
                    <IconZoomIn size={12} />
                  </button>
                )}
              </button>
            );
          })}
        </div>
      ) : iteration.resultImage && imageUrl ? (
        <div className={styles.singleImageWrapper}>
          <ImageWithLoader
            src={imageUrl}
            alt={`Result: ${iteration.prompt.slice(0, 80)}`}
            blurred={selectedBlurred}
            onZoom={
              !selectedBlurred && onZoomImage
                ? () =>
                    onZoomImage(
                      getEdgeUrl(iteration.resultImage!.previewUrl, { width: 1200 }) ??
                        iteration.resultImage!.previewUrl
                    )
                : undefined
            }
          />
          {selectedBlurred && (
            <div className={styles.unlockOverlay}>
              <IconLock size={20} />
              <Text size="sm" fw={600}>
                Mature content
              </Text>
              <Text size="xs" ta="center" px="xs">
                Your Buzz paid for this — open it on civitai.red to view it and
                use it as source.
              </Text>
              {unlockOnRedUrl ? (
                <Button
                  component="a"
                  href={unlockOnRedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="compact-sm"
                  variant="light"
                  color="red"
                  leftSection={<IconExternalLink size={12} />}
                  mt={4}
                >
                  Unlock on civitai.red
                </Button>
              ) : (
                <Text size="xs" c="dimmed">
                  Open the Generator queue to manage this workflow.
                </Text>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Footer: cost badge, annotation badge, use-as-source button */}
      <div className={styles.iterationFooter}>
        {iteration.cost > 0 && (
          <span className={styles.costBadge}>
            <IconBolt size={12} />
            {iteration.cost}
          </span>
        )}
        {iteration.annotated && (
          <span className={styles.annotatedBadge}>
            <IconPencil size={12} />
            Annotated
          </span>
        )}
        {isCurrentSource && iteration.status === 'ready' && (
          <span className={styles.currentSourceBadge}>
            <IconCheck size={12} />
            Current source
          </span>
        )}
        <div className="flex-1" />
        {iteration.status === 'ready' && iteration.resultImage && !isCurrentSource && (
          selectedBlurred ? (
            <Tooltip
              label="Mature image — unlock on civitai.red to use it as source"
              withArrow
              position="top"
            >
              <Button
                component={unlockOnRedUrl ? 'a' : 'button'}
                {...(unlockOnRedUrl
                  ? { href: unlockOnRedUrl, target: '_blank', rel: 'noopener noreferrer' }
                  : { disabled: true })}
                size="compact-xs"
                variant="light"
                color="red"
                leftSection={<IconExternalLink size={12} />}
              >
                Unlock on red
              </Button>
            </Tooltip>
          ) : (
            <Button size="compact-xs" variant="light" color="yellow" onClick={onUseAsSource}>
              Use as source
            </Button>
          )
        )}
      </div>
    </div>
  );
}

function ImageWithLoader({
  src,
  alt,
  onZoom,
  blurred,
}: {
  src: string;
  alt: string;
  onZoom?: () => void;
  blurred?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className={styles.iterationImage} style={{ position: 'relative' }}>
      {!loaded && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Loader size="sm" color="gray" />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={blurred ? styles.blurredImage : undefined}
        style={loaded ? undefined : { position: 'absolute', opacity: 0 }}
      />
      {loaded && !blurred && onZoom && (
        <button type="button" className={styles.zoomButton} onClick={onZoom}>
          <IconZoomIn size={12} />
        </button>
      )}
    </div>
  );
}
