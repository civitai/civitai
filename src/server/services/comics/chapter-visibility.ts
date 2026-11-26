import { hasBlockMarker, ownerMediaAllowed } from '~/server/common/image-block-marker';
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

/**
 * Whether a block leaves `viewerId` an image's media: a moderator keeps it, its owner per
 * `ownerMediaAllowed`, anyone else only when the image carries no block.
 */
export function blockLeavesMedia(
  image: PanelImage,
  viewerId?: number | null,
  actsAsModerator = false
) {
  if (actsAsModerator) return true;
  if (viewerId != null && image.userId === viewerId) return ownerMediaAllowed(image);
  return !hasBlockMarker(image);
}

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
 * Withholds each panel image `viewerId` may not see, and the media of every one that fails
 * `ownerMediaAllowed` (a block, not an owner-clearable hold) from everyone but a moderator, its owner
 * included. A blocked panel keeps its image row, so the owner still sees the block and its reason.
 * Unlike a tainted panel this keeps the chapter up: the flag is never cleared (only a re-rating below
 * R lifts it), so holding the chapter back would not clear.
 */
export function withholdRestrictedPanelImages(
  chapters: { panels: { imageUrl: string | null; image: PanelImage | null }[] }[],
  viewerId?: number,
  actsAsModerator = false
) {
  for (const { panels } of chapters) {
    for (const panel of panels) {
      if (!panel.image) continue;
      if (!isImageServable(panel.image, viewerId)) {
        panel.imageUrl = null;
        panel.image = null;
      } else if (!actsAsModerator && !ownerMediaAllowed(panel.image)) {
        panel.imageUrl = null;
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
