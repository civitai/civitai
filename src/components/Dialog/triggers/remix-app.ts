import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { RemixAppModalProps } from '~/components/Image/Remix/RemixAppModal';
import type { RemixAppPickerProps } from '~/components/Image/Remix/RemixAppPicker';

// Dynamic: the Remix menu is on every image card, and most viewers never open an app.
const RemixAppModal = dynamic(
  () => import('~/components/Image/Remix/RemixAppModal').then((mod) => mod.RemixAppModal),
  { ssr: false }
);

export function openRemixAppModal(props: RemixAppModalProps) {
  dialogStore.trigger({ component: RemixAppModal, props });
}

const RemixAppPicker = dynamic(
  () => import('~/components/Image/Remix/RemixAppPicker').then((mod) => mod.RemixAppPicker),
  { ssr: false }
);

export function openRemixAppPicker(props: RemixAppPickerProps) {
  dialogStore.trigger({ component: RemixAppPicker, props });
}
