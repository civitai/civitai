import type { MouseEvent } from 'react';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import type { StorylineReadTarget } from '~/components/Storyline/storyline-mode.utils';

/**
 * A click the browser should handle itself: a new tab or window, a download, a middle click.
 */
const isModifiedClick = (e: MouseEvent) =>
  e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

/**
 * Props for a chapter link: its href stays the reader URL, so a new tab or a copied link opens
 * the reader, while a plain click opens it as a dialog over the current page and closing it comes
 * back there.
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
