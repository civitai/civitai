import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const StorylineManageModal = dynamic(
  () => import('~/components/Storyline/manage/StorylineManageModal')
);

export function openStorylineManageModal(props: { storylineId: number }) {
  dialogStore.trigger({ component: StorylineManageModal, props });
}
