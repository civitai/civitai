-- Takedown CDN sync, second step. Apply by hand AFTER 20261111120000_cdn_access_sync.

-- A moderator-app hard delete, kept after its Image row is gone so the url stays taken down through
-- every later re-check, and so a held owner's takedown can be upgraded once the hold ends.
-- `csamReview` defaults to true: a delete that did not say is treated as held.
CREATE TABLE IF NOT EXISTS "ImageCdnModeratorDelete" (
  "imageId"    integer PRIMARY KEY,
  url          text NOT NULL,
  "userId"     integer,
  "csamReview" boolean NOT NULL DEFAULT true,
  "deletedAt"  timestamp(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ImageCdnModeratorDelete_url_idx" ON "ImageCdnModeratorDelete" (url);

-- A short lease on one url while a run tells the image server about it, so two runs never send
-- calls for the same url at once.
CREATE TABLE IF NOT EXISTS "ImageCdnAccessClaim" (
  url            text PRIMARY KEY,
  token          text NOT NULL,
  "claimedUntil" timestamp(3) NOT NULL
);
