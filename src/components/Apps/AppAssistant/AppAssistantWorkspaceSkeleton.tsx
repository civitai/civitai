import { Paper, Skeleton } from '@mantine/core';
import clsx from 'clsx';
import classes from './AppAssistant.module.scss';

/**
 * What `/apps/build` shows while the App Assistant workspace's chunk loads, which a client-side
 * navigation into the assistant view waits on. It takes the workspace's own box (`.workspace`) and
 * the chat pane at full width, which is how the workspace first renders (the preview pane only
 * opens with a preview session), so the page does not jump when the workspace replaces it.
 */
export function AppAssistantWorkspaceSkeleton() {
  return (
    <div
      className={clsx('flex flex-col gap-3', classes.workspace)}
      data-testid="app-assistant-workspace-skeleton"
      role="status"
    >
      <span className="sr-only">Loading the App Assistant</span>
      <div className="flex min-h-0 flex-1 gap-3" aria-hidden>
        <Paper withBorder radius="md" p="md" className="flex w-full flex-col gap-3">
          <Skeleton height={14} width="40%" radius="sm" />
          <Skeleton height={14} width="75%" radius="sm" />
          <Skeleton height={14} width="60%" radius="sm" />
          <div className="flex-1" />
          <Skeleton height={44} radius="md" />
        </Paper>
      </div>
    </div>
  );
}
