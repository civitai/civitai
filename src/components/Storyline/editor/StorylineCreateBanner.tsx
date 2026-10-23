import { StorylineEditorBanner } from '~/components/Storyline/editor/StorylineEditorBanner';
import { trpc } from '~/utils/trpc';

/** On the new-post page, before the post exists: the storyline the first upload will start. */
export function StorylineCreateBanner({ storylineId }: { storylineId: number }) {
  const { data } = trpc.storyline.getById.useQuery({ id: storylineId });
  if (!data) return null;
  return <StorylineEditorBanner variant="start" storyline={{ id: data.id, title: data.title }} />;
}
