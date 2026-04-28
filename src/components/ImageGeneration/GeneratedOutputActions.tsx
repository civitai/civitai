import { Menu } from '@mantine/core';
import {
  IconDownload,
  IconHeart,
  IconThumbDown,
  IconThumbUp,
  IconWand,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { GeneratedItemWorkflowMenu } from '~/components/generation_v2/GeneratedItemWorkflowMenu';
import { useGeneratedItemWorkflows } from '~/components/generation_v2/hooks/useGeneratedItemWorkflows';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import { fetchBlob } from '~/utils/file-utils';
import { showErrorNotification } from '~/utils/notifications';

import classes from './GeneratedImage.module.css';

export function GeneratedOutputActions({
  output,
  state,
  isLightbox,
  infoSlot,
  onToggleFavorite,
  onToggleFeedback,
}: {
  output: BlobData;
  state: { favorite?: boolean; feedback?: string };
  isLightbox?: boolean;
  infoSlot?: ReactNode;
  onToggleFavorite: (value: boolean) => void;
  onToggleFeedback: (feedback: 'liked' | 'disliked') => void;
}) {
  const { groups } = useGeneratedItemWorkflows({
    outputType: output.mediaType,
    ecosystemKey: output.ecosystemKey,
  });
  const hasWorkflows = groups.some((g) => g.workflows.length > 0);

  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await fetchBlob(output.url);
      if (!blob) throw new Error('Failed to fetch file');
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${output.id}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(href);
    } catch (e) {
      showErrorNotification({
        title: 'Download failed',
        error: e instanceof Error ? e : new Error('Unknown error'),
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={clsx(classes.actionsFooter, 'flex w-full items-center')}>
      <div className="flex items-center gap-1">
        <LegacyActionIcon
          size="md"
          className={state.favorite ? classes.favoriteButton : undefined}
          variant={state.favorite ? 'light' : 'subtle'}
          color={state.favorite ? 'red' : 'gray'}
          onClick={() => onToggleFavorite(!state.favorite)}
        >
          <IconHeart size={16} />
        </LegacyActionIcon>

        <LegacyActionIcon
          size="md"
          variant={state.feedback === 'liked' ? 'light' : 'subtle'}
          color={state.feedback === 'liked' ? 'green' : 'gray'}
          onClick={() => onToggleFeedback('liked')}
        >
          <IconThumbUp size={16} />
        </LegacyActionIcon>

        <LegacyActionIcon
          size="md"
          variant={state.feedback === 'disliked' ? 'light' : 'subtle'}
          color={state.feedback === 'disliked' ? 'red' : 'gray'}
          onClick={() => onToggleFeedback('disliked')}
        >
          <IconThumbDown size={16} />
        </LegacyActionIcon>

        {hasWorkflows && (
          <Menu
            zIndex={400}
            trigger="click-hover"
            openDelay={100}
            closeDelay={100}
            transitionProps={{ transition: 'fade', duration: 150 }}
            withinPortal
            position="top"
            withArrow
          >
            <Menu.Target>
              <LegacyActionIcon size="md">
                <IconWand size={16} />
              </LegacyActionIcon>
            </Menu.Target>
            <Menu.Dropdown className={clsx(classes.improveMenu, classes.scrollableDropdown)}>
              <GeneratedItemWorkflowMenu image={output} workflowsOnly isLightbox={isLightbox} />
            </Menu.Dropdown>
          </Menu>
        )}

        <LegacyActionIcon
          size="md"
          onClick={handleDownload}
          loading={downloading}
          aria-label="Download"
        >
          <IconDownload size={16} />
        </LegacyActionIcon>
      </div>
      {infoSlot && (
        <>
          <div className="flex-1" />
          {infoSlot}
        </>
      )}
    </div>
  );
}
