import { openDialog } from '~/components/Dialog/openDialog';
import type { RemixAppModalProps } from '~/components/Image/Remix/RemixAppModal';
import type { RemixAppPickerProps } from '~/components/Image/Remix/RemixAppPicker';

// Lazy: the Remix menu is on every image card, and most viewers never open an app.
export function openRemixAppModal(props: RemixAppModalProps) {
  openDialog(() => import('~/components/Image/Remix/RemixAppModal'), 'RemixAppModal', props);
}

export function openRemixAppPicker(props: RemixAppPickerProps) {
  openDialog(() => import('~/components/Image/Remix/RemixAppPicker'), 'RemixAppPicker', props);
}
