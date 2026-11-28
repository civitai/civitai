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

/** The text-scan holds a lift's confirmed-song guard reads (`confirmedLyricsHoldSql`). */
export const TEXT_SCAN_HOLD_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "TextScanHold" ("entityType" text, "entityId" int, label text, status text);`;

/** What the generic review queues read to leave out the songs and covers Audio review's Held tab
 *  decides (`onHeldTabText`): songs' covers and their lyrics holds. */
export const HELD_TAB_TABLE_SQL = `${TEXT_SCAN_HOLD_TABLE_SQL}
CREATE TABLE IF NOT EXISTS "Track" ("imageId" int PRIMARY KEY, "coverImageId" int UNIQUE, genre text);`;
