import type { MouseEvent } from 'react';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import type { StorylineReadTarget } from '~/components/Storyline/storyline-mode.utils';

/** Left to the browser, so new-tab, new-window and download gestures still follow the href. */
export const isModifiedClick = (e: MouseEvent) =>
  e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

/**
 * The href stays the full reader URL so a copied link or a new tab works; a plain click opens it
 * as a dialog over the current page instead.
 */
export function storylineChapterLinkProps(link: {
  href: string;
  read: StorylineReadTarget | null;
}) {
  const { href, read } = link;
  return {
    href,
    onClick: read
      ? (e: MouseEvent<HTMLElement>) => {
          if (isModifiedClick(e)) return;
          e.preventDefault();
          triggerRoutedDialog({
            name: 'imageDetail',
            state: {
              imageId: read.imageId,
              storylineChapterId: read.chapterId,
              storylineVia: read.via,
            },
          });
        }
      : undefined,
  };
}
