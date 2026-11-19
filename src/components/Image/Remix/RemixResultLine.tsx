import { ActionIcon, Button, Switch } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconLayoutList, IconRotateClockwise } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/**
 * Under a finished run: Remix again and Open in queue on the left; the Remix gallery switch with
 * its price, then Post, on the right.
 */
export function RemixResultLine({
  onRemixAgain,
  onOpenQueue,
  gallery,
  onPost,
  posting,
  remixAgainDisabled,
  postDisabled,
}: {
  onRemixAgain: () => void;
  onOpenQueue: () => void;
  /** Absent when this run cannot go to the Remix gallery. */
  gallery?: { checked: boolean; onChange: (checked: boolean) => void; price: ReactNode };
  onPost: () => void;
  posting?: boolean;
  remixAgainDisabled?: boolean;
  postDisabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="remix-result-line">
      <Tooltip label="Remix again" visibleFrom="sm">
        <ActionIcon
          variant="default"
          size="lg"
          aria-label="Remix again"
          onClick={onRemixAgain}
          disabled={remixAgainDisabled}
        >
          <IconRotateClockwise size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Open in queue" visibleFrom="sm">
        <ActionIcon variant="default" size="lg" aria-label="Open in queue" onClick={onOpenQueue}>
          <IconLayoutList size={18} />
        </ActionIcon>
      </Tooltip>
      <div className="ml-auto flex items-center gap-3">
        {gallery && (
          <Switch
            size="sm"
            checked={gallery.checked}
            onChange={(e) => gallery.onChange(e.currentTarget.checked)}
            disabled={postDisabled}
            label={
              <span className="flex items-center gap-1 whitespace-nowrap">
                Remix gallery <span aria-hidden>·</span> {gallery.price}
              </span>
            }
          />
        )}
        <Button className="shrink-0" onClick={onPost} loading={posting} disabled={postDisabled}>
          Post
        </Button>
      </div>
    </div>
  );
}
