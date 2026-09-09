import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { RemixSourcesModalProps } from '~/components/RemixGallery/RemixSourcesModal';

/**
 * 🔴 Dynamic, and that is the whole point of this file.
 *
 * The caller is `ImageMenuItems`, which every image card imports statically. A
 * static import of the modal drags `RemixSourcesList` and the Buzz button stack
 * into every feed page's chunk, for a dialog 0.076% of images can ever open.
 */
const RemixSourcesModal = dynamic(
  () => import('~/components/RemixGallery/RemixSourcesModal').then((mod) => mod.RemixSourcesModal),
  { ssr: false }
);

export function openRemixSourcesModal(props: RemixSourcesModalProps) {
  dialogStore.trigger({ component: RemixSourcesModal, props });
}
