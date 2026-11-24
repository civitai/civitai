import { openDialog } from '~/components/Dialog/openDialog';
import type { StorylineContinueModalProps } from '~/components/Storyline/continue/StorylineContinueModal';

export function openStorylineContinueModal(props: StorylineContinueModalProps) {
  openDialog(() => import('~/components/Storyline/continue/StorylineContinueModal'), props);
}
