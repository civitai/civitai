import { Button, Loader, Text } from '@mantine/core';
import {
  IconBolt,
  IconCheck,
  IconPencil,
  IconRefresh,
  IconWand,
  IconZoomIn,
} from '@tabler/icons-react';
import clsx from 'clsx';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { IterationEntry, SourceImage } from './iterative-editor.types';
import styles from './IterativeImageEditor.module.scss';

interface IterationMessageProps {
  iteration: IterationEntry;
  isCurrentSource: boolean;
  onUseAsSource: () => void;
  onSelectImage?: (image: SourceImage) => void;
  onRetry?: () => void;
  onZoomImage?: (url: string) => void;
}

export function IterationMessage({
  iteration,
  isCurrentSource,
  onUseAsSource,
  onSelectImage,
  onRetry,
  onZoomImage,
}: IterationMessageProps) {
  const hasMultipleImages = iteration.resultImages.length > 1;
  const selectedUrl = iteration.resultImage?.url;

  const imageUrl = iteration.resultImage
    ? getEdgeUrl(iteration.resultImage.previewUrl, { width: 400 }) ??
      iteration.resultImage.previewUrl
    : null;

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
      ) : hasMultipleImages ? (
        // Multi-image grid: show all results, highlight selected
        <div className={styles.multiImageGrid}>
          {iteration.resultImages.map((img, idx) => {
            const thumbUrl =
              getEdgeUrl(img.previewUrl, { width: 200 }) ?? img.previewUrl;
            const isSelected = img.url === selectedUrl;
            return (
              <button
                key={idx}
                className={clsx(
                  styles.multiImageThumb,
                  isSelected && styles.multiImageThumbSelected
                )}
                onClick={() => onSelectImage?.(img)}
                type="button"
              >
                <img src={thumbUrl} alt={`Option ${idx + 1}`} />
                {isSelected && (
                  <div className={styles.multiImageCheck}>
                    <IconCheck size={14} />
                  </div>
                )}
                {onZoomImage && (
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
        <div className={styles.iterationImage}>
          <img src={imageUrl} alt={`Result: ${iteration.prompt.slice(0, 80)}`} />
          {onZoomImage && (
            <button
              type="button"
              className={styles.zoomButton}
              onClick={() =>
                onZoomImage(
                  getEdgeUrl(iteration.resultImage!.previewUrl, { width: 1200 }) ??
                    iteration.resultImage!.previewUrl
                )
              }
            >
              <IconZoomIn size={12} />
            </button>
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
          <Button size="compact-xs" variant="light" color="yellow" onClick={onUseAsSource}>
            Use as source
          </Button>
        )}
      </div>
    </div>
  );
}
