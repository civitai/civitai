import { Button } from '@mantine/core';
import { IconBolt, IconCheck, IconPencil } from '@tabler/icons-react';
import clsx from 'clsx';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import styles from './IterativePanelEditor.module.scss';

export interface SourceImage {
  url: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface IterationEntry {
  id: string;
  prompt: string;
  annotated: boolean;
  sourceImage: SourceImage | null;
  resultImage: SourceImage | null;
  cost: number;
  timestamp: Date;
  status: 'generating' | 'ready' | 'error';
  errorMessage?: string;
}

interface IterationMessageProps {
  iteration: IterationEntry;
  isCurrentSource: boolean;
  onUseAsSource: () => void;
}

export function IterationMessage({
  iteration,
  isCurrentSource,
  onUseAsSource,
}: IterationMessageProps) {
  const imageUrl = iteration.resultImage
    ? iteration.resultImage.previewUrl.startsWith('http')
      ? iteration.resultImage.previewUrl
      : getEdgeUrl(iteration.resultImage.previewUrl, { width: 400 }) ??
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

      {/* Result image or loading/error state */}
      {iteration.status === 'generating' ? (
        <div className={styles.generatingSkeleton}>
          <div className={styles.spinner} />
        </div>
      ) : iteration.status === 'error' ? (
        <div className={styles.errorBox}>
          {iteration.errorMessage || 'Generation failed. Buzz has been refunded.'}
        </div>
      ) : iteration.resultImage && imageUrl ? (
        <div className={styles.iterationImage}>
          <img src={imageUrl} alt="Generated result" />
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
        <div style={{ flex: 1 }} />
        {iteration.status === 'ready' && iteration.resultImage && !isCurrentSource && (
          <Button size="compact-xs" variant="light" color="yellow" onClick={onUseAsSource}>
            Use as source
          </Button>
        )}
      </div>
    </div>
  );
}
