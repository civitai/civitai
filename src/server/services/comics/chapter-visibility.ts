import { blockLeavesMedia } from '~/server/common/image-block-marker';
import {
  imageRestrictionSelect,
  isImageServable,
  withServableImage,
  type RestrictableImage,
} from '~/server/common/image-visibility';
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

/** What `withholdRestrictedPanelImages` reads from a panel's `Image`. */
export const panelImageVisibilitySelect = {
  ...imageRestrictionSelect,
  ingestion: true,
  blockedFor: true,
} as const;

type PanelImage = RestrictableImage & { ingestion: string; blockedFor: string | null };

/** What `withServableCover` reads beyond `imageRestrictionSelect`. */
export const coverBlockSelect = { ingestion: true, blockedFor: true } as const;

export { blockLeavesMedia };

/** `withServableImage` for a cover or hero image, also withheld where `blockLeavesMedia` is false. */
export function withServableCover<
  K extends PropertyKey,
  T extends { [P in K]: PanelImage | null | undefined }
>(row: T, key: K, viewerId?: number | null, actsAsModerator = false) {
  const servable = withServableImage(row, key, viewerId);
  const image = servable[key];
  return image && !blockLeavesMedia(image, viewerId, actsAsModerator)
    ? { ...servable, [key]: null }
    : servable;
}

/**
 * Withholds each panel image `viewerId` may not see, and the media of each one `blockLeavesMedia`
 * refuses them, blur hash included. A blocked panel keeps its image row so its owner still sees the
 * block.
 * Unlike a tainted panel this keeps the chapter up: only a re-rating below R lifts the restriction,
 * so holding the chapter back would never end.
 */
export function withholdRestrictedPanelImages<I extends PanelImage & { hash?: string | null }>(
  chapters: { panels: { imageUrl: string | null; image: I | null }[] }[],
  viewerId?: number,
  actsAsModerator = false
) {
  for (const { panels } of chapters) {
    for (const panel of panels) {
      if (!panel.image) continue;
      if (!isImageServable(panel.image, viewerId)) {
        panel.imageUrl = null;
        panel.image = null;
      } else if (!blockLeavesMedia(panel.image, viewerId, actsAsModerator)) {
        panel.imageUrl = null;
        if (panel.image.hash != null) panel.image = { ...panel.image, hash: null };
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
