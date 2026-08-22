import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const AddToHubModal = dynamic(() => import('~/components/Hubs/AddToHubModal'), { ssr: false });

export const openAddToHubModal = createDialogTrigger(AddToHubModal);
