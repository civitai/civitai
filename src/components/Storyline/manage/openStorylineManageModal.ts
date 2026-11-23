import { openDialog } from '~/components/Dialog/openDialog';

export function openStorylineManageModal(props: { storylineId: number }) {
  openDialog(() => import('~/components/Storyline/manage/StorylineManageModal'), props);
}
