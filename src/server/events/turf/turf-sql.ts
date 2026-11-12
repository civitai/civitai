import { Prisma } from '@prisma/client';

// An image anyone may see: in a published, non-private post, scanned and not held or blocked.
// Placement, the sticker read and the flag swap all require it, so nothing is placed or raised as a
// flag where it cannot be drawn. Aliases i (Image) and p (Post).
export const imageVisible = Prisma.sql`p."publishedAt" <= now() AND p.availability <> 'Private'
  AND i.ingestion = 'Scanned' AND NOT i."tosViolation" AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL`;
// Read apart from ownerAllowsTurf so a banned owner's image is not blamed on the owner's switch.
// Alias o (the image's owner).
export const ownerActive = Prisma.sql`o."bannedAt" IS NULL AND o."deletedAt" IS NULL`;
