import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { WildcardPreviewModalProps } from '~/components/Generate/Input/WildcardPreviewModal';

const WildcardPreviewModal = dynamic(
  () => import('~/components/Generate/Input/WildcardPreviewModal'),
  { ssr: false }
);

export const openWildcardPreview = (props: WildcardPreviewModalProps) =>
  dialogStore.trigger({ component: WildcardPreviewModal, props });
