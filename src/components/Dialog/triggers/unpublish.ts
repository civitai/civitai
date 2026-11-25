import type { ComponentProps } from 'react';
import { openDialog } from '~/components/Dialog/openDialog';
import type UnpublishModal from '~/components/Modals/UnpublishModal';

export function openUnpublishModal({ props }: { props: ComponentProps<typeof UnpublishModal> }) {
  openDialog(() => import('~/components/Modals/UnpublishModal'), props);
}
