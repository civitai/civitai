import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const VersionShowcaseEditor = dynamic(
  () => import('~/components/Model/VersionShowcase/VersionShowcaseEditor'),
  { ssr: false }
);

export function openVersionShowcaseEditor(props: { modelVersionId: number; addImageId?: number }) {
  dialogStore.trigger({ component: VersionShowcaseEditor, props });
}
