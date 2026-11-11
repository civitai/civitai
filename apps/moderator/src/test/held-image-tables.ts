/** The tables a block's held check and its deferred effects read, for a PGlite schema with `"Image"`. */
export const SET_ASIDE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "CsamQueueSetAside" (
  "imageId" int PRIMARY KEY,
  "userId" int,
  outcome text NOT NULL,
  "moderatorId" int,
  "createdAt" timestamp(3) NOT NULL DEFAULT now()
);`;

export const DEFERRED_BLOCK_EFFECT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "ImageDeferredBlockEffect" (
  "imageId" int PRIMARY KEY,
  "violationType" text,
  "notifyOwner" boolean NOT NULL DEFAULT true,
  "reportReason" text,
  "reportIds" int[] NOT NULL DEFAULT '{}',
  "blockedBy" int,
  "createdAt" timestamp(3) NOT NULL DEFAULT now()
);`;
