import { Menu } from '@mantine/core';
import { IconHeart, IconThumbDown, IconThumbUp, IconWand } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';

import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { GeneratedItemWorkflowMenu } from '~/components/generation_v2/GeneratedItemWorkflowMenu';
import type { BlobData } from '~/shared/orchestrator/workflow-data';

import classes from './GeneratedImage.module.css';

export function GeneratedOutputActions({
  output,
  state,
  isLightbox,
  isOverlay,
  isMobileFooter,
  onToggleFavorite,
  onToggleFeedback,
}: {
  output: BlobData;
  state: { favorite?: boolean; feedback?: string };
  isLightbox?: boolean;
  isOverlay?: boolean;
  isMobileFooter?: boolean;
  onToggleFavorite: (value: boolean) => void;
  onToggleFeedback: (feedback: 'liked' | 'disliked') => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (isLightbox || isOverlay) {
    return (
      <div
        className={clsx(
          classes.actionsWrapper,
          (menuOpen || isLightbox) && classes.actionsVisible,
          isOverlay && classes.desktopOnly,
          output.type === 'video' || output.type === 'audio'
            ? 'bottom-2 left-12'
            : 'bottom-1 left-1',
          'absolute flex flex-wrap items-center gap-1 p-1'
        )}
      >
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

        <Menu
          zIndex={400}
          trigger="click-hover"
          openDelay={100}
          closeDelay={100}
          transitionProps={{
            transition: 'fade',
            duration: 150,
          }}
          withinPortal
          position="top"
          onChange={setMenuOpen}
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
      </div>
    );
  }

  return (
    <div
      className={clsx(classes.actionsFooter, isMobileFooter && classes.mobileOnly, 'flex w-full')}
    >
      <LegacyActionIcon
        className={classes.footerActionIcon}
        variant={state.favorite ? 'light' : 'subtle'}
        color={state.favorite ? 'red' : 'gray'}
        onClick={() => onToggleFavorite(!state.favorite)}
      >
        <IconHeart size={16} />
      </LegacyActionIcon>

      <div className={classes.footerDivider} />

      <LegacyActionIcon
        className={classes.footerActionIcon}
        variant={state.feedback === 'liked' ? 'light' : 'subtle'}
        color={state.feedback === 'liked' ? 'green' : 'gray'}
        onClick={() => onToggleFeedback('liked')}
      >
        <IconThumbUp size={16} />
      </LegacyActionIcon>

      <div className={classes.footerDivider} />

      <LegacyActionIcon
        className={classes.footerActionIcon}
        variant={state.feedback === 'disliked' ? 'light' : 'subtle'}
        color={state.feedback === 'disliked' ? 'red' : 'gray'}
        onClick={() => onToggleFeedback('disliked')}
      >
        <IconThumbDown size={16} />
      </LegacyActionIcon>

      <div className={classes.footerDivider} />

      <Menu
        zIndex={400}
        trigger="click"
        transitionProps={{ transition: 'fade', duration: 150 }}
        withinPortal
        position="top"
        onChange={setMenuOpen}
        withArrow
      >
        <Menu.Target>
          <LegacyActionIcon className={classes.footerActionIcon}>
            <IconWand size={16} />
          </LegacyActionIcon>
        </Menu.Target>
        <Menu.Dropdown className={clsx(classes.improveMenu, classes.scrollableDropdown)}>
          <GeneratedItemWorkflowMenu image={output} workflowsOnly />
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
