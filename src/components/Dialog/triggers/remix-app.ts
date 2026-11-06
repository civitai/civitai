import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { RemixAppModalProps } from '~/components/Image/Remix/RemixAppModal';

// Dynamic: the Remix menu is on every image card, and most viewers never open an app.
const RemixAppModal = dynamic(
  () => import('~/components/Image/Remix/RemixAppModal').then((mod) => mod.RemixAppModal),
  { ssr: false }
);

export function openRemixAppModal(props: RemixAppModalProps) {
  dialogStore.trigger({ component: RemixAppModal, props });
}
