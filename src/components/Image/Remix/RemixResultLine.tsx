import { Button, Switch } from '@mantine/core';
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
      {/* Labelled, not icon-only: a tooltip never shows on a phone. */}
      <Button
        variant="default"
        leftSection={<IconRotateClockwise size={16} />}
        onClick={onRemixAgain}
        disabled={remixAgainDisabled}
      >
        Remix again
      </Button>
      <Button variant="default" leftSection={<IconLayoutList size={16} />} onClick={onOpenQueue}>
        Open in queue
      </Button>
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
