import type { ComponentProps } from 'react';
import { openDialog } from '~/components/Dialog/openDialog';
import type AddToHubModal from '~/components/Hubs/AddToHubModal';

export function openAddToHubModal({ props }: { props: ComponentProps<typeof AddToHubModal> }) {
  openDialog(() => import('~/components/Hubs/AddToHubModal'), props);
}
