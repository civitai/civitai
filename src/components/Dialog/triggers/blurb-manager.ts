import { openDialog } from '~/components/Dialog/openDialog';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';

// Lazy so the editor never evaluates the manager, which hosts a nested RichTextEditor, at module load.
export function openBlurbManager(props: { onInsert?: (blurb: BlurbItem) => void } = {}) {
  openDialog(() => import('~/components/RichTextEditor/BlurbManagerModal'), props, {
    id: 'blurb-manager',
  });
}
