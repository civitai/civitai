import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';

// `ssr: false` and lazy: the manager hosts a nested RichTextEditor, so a static import from the
// editor would be a cycle.
const BlurbManagerModal = dynamic(() => import('~/components/RichTextEditor/BlurbManagerModal'), {
  ssr: false,
});

export function openBlurbManager(props: { onInsert?: (blurb: BlurbItem) => void } = {}) {
  dialogStore.trigger({ id: 'blurb-manager', component: BlurbManagerModal, props });
}
