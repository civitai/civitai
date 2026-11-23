import { openDialog } from '~/components/Dialog/openDialog';
import type { StorylineFirstChapterModalProps } from '~/components/Storyline/StorylineFirstChapterModal';

export function openStorylineFirstChapterModal(props: StorylineFirstChapterModalProps) {
  openDialog(() => import('~/components/Storyline/StorylineFirstChapterModal'), props);
}
