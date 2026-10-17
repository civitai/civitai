import {
  getStorylineChapterName,
  routeVia,
  storylineReadHref,
} from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';
import type { StorylineLaneEdge } from '~/shared/utils/storyline-lanes';
import { createStorylineLaneRouter, layoutStorylineLanes } from '~/shared/utils/storyline-lanes';

type LaneMapChapter = StorylinePathChapter & { firstImage: { id: number } | null };

/**
 * The Story page map of a storyline graph: its lane layout, and for each chapter the name and link
 * the map shows. Both follow the route the map draws to the chapter, so the number in an untitled
 * chapter's name is the one the reader shows when the link opens it. Null without chapter 1.
 */
export function buildStorylineLaneMap<T extends LaneMapChapter>(graph: {
  rootChapterId: number | null;
  chapters: T[];
  edges: StorylineLaneEdge[];
  truncated: boolean;
}) {
  if (!graph.rootChapterId) return null;
  const layout = layoutStorylineLanes(
    graph.rootChapterId,
    graph.chapters.map((c) => c.chapterId),
    graph.edges
  );
  const routeTo = createStorylineLaneRouter(layout);
  const chapterById = new Map(graph.chapters.map((c) => [c.chapterId, c]));
  const parentCount = new Map<number, number>();
  for (const link of layout.links)
    parentCount.set(link.chapterId, (parentCount.get(link.chapterId) ?? 0) + 1);

  const nodes = layout.nodes.flatMap((node) => {
    const chapter = chapterById.get(node.chapterId);
    if (!chapter) return [];
    const route = routeTo(node.chapterId).map((chapterId) => ({
      chapterId,
      parentCount: parentCount.get(chapterId),
    }));
    const { post, firstImage } = chapter;
    return {
      ...node,
      chapter,
      name: getStorylineChapterName({ ...chapter, depth: route.length - 1 }, { withAuthor: true }),
      href: !post
        ? null
        : firstImage
        ? storylineReadHref({
            imageId: firstImage.id,
            chapterId: node.chapterId,
            via: routeVia(route),
          })
        : `/posts/${post.id}`,
    };
  });
  return { layout, nodes, truncated: graph.truncated };
}
