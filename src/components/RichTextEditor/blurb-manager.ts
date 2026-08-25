import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';

// Loaded lazily so the editor bundle doesn't carry the manager, and so the manager can host a
// nested RichTextEditor without the two modules forming a static import cycle.
const BlurbManagerModal = dynamic(() => import('~/components/RichTextEditor/BlurbManagerModal'));

export function openBlurbManager(props: { onInsert?: (blurb: BlurbItem) => void } = {}) {
  dialogStore.trigger({ id: 'blurb-manager', component: BlurbManagerModal, props });
}
