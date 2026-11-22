import { isImageServable, type RestrictableImage } from '~/server/common/image-visibility';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import {
  ComicPanelStatus,
  ComicProjectStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';

/** The panels the public reader serves, as a Prisma `panels` relation filter. */
export const readerPanelsWhere = {
  status: ComicPanelStatus.Ready,
  imageUrl: { not: null },
} as const;

type ReaderPanel = {
  image: { tosViolation: boolean; needsReview: string | null; ingestion: string } | null;
};

/** A panel whose image is not yet clean, which holds its chapter back from anyone but owner and mods. */
export const isPanelTainted = ({ image }: ReaderPanel) =>
  !image ||
  image.tosViolation ||
  !!image.needsReview ||
  image.ingestion !== ImageIngestionStatus.Scanned;

/**
 * Withholds each panel image `viewerId` may not see. Unlike a tainted panel this keeps the chapter
 * up: the flag is never cleared (only a re-rating below R lifts it), so holding the chapter back would
 * not clear.
 */
export function withholdRestrictedPanelImages(
  chapters: { panels: { imageUrl: string | null; image: RestrictableImage | null }[] }[],
  viewerId?: number,
  isModerator?: boolean
) {
  for (const { panels } of chapters) {
    for (const panel of panels) {
      if (panel.image && !isImageServable(panel.image, viewerId, isModerator)) {
        panel.imageUrl = null;
        panel.image = null;
      }
    }
  }
}

type ReaderProject = {
  userId: number;
  status: string;
  tosViolation: boolean;
  publishedAt: Date | null;
  user: { bannedAt: Date | null } | null;
};

/**
 * Whether the public reader refuses this project to the viewer, before it looks at any chapter. A
 * deleted project is refused to everyone; the rest pass its owner and moderators.
 */
export async function isComicProjectHidden(
  project: ReaderProject,
  viewer: { id: number; isModerator?: boolean } | null | undefined
) {
  if (project.status === ComicProjectStatus.Deleted) return true;
  if (viewer && (viewer.id === project.userId || viewer.isModerator === true)) return false;
  if (project.tosViolation || project.user?.bannedAt || project.publishedAt == null) return true;
  const excluded = await Promise.all([
    HiddenUsers.getCached({ userId: viewer?.id }),
    BlockedByUsers.getCached({ userId: viewer?.id }),
    BlockedUsers.getCached({ userId: viewer?.id }),
  ]);
  return excluded.flat().some((u) => u.id === project.userId);
}
