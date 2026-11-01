import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { StorylineFirstChapterModalProps } from '~/components/Storyline/StorylineFirstChapterModal';

const StorylineFirstChapterModal = dynamic(
  () => import('~/components/Storyline/StorylineFirstChapterModal')
);

export function openStorylineFirstChapterModal(props: StorylineFirstChapterModalProps) {
  dialogStore.trigger({ component: StorylineFirstChapterModal, props });
}
