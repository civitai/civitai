import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { StorylineContinueModalProps } from '~/components/Storyline/continue/StorylineContinueModal';

const StorylineContinueModal = dynamic(
  () => import('~/components/Storyline/continue/StorylineContinueModal')
);

export function openStorylineContinueModal(props: StorylineContinueModalProps) {
  dialogStore.trigger({ component: StorylineContinueModal, props });
}
