import type { ColumnType } from 'kysely';

// Schema for the MODERATOR database — moderation data that never existed in Civitai's Postgres.
//
// Hand-written, unlike `@civitai/db-schema/kysely`, because these tables are not in the Prisma schema.
// Today the connection points at Retool's own database (`retool_db` in the app exports), so these types
// mirror its live schema exactly, quirks included. When the tables move to a dedicated moderator
// database the definitions here are what the migration targets — see
// docs/moderator-app/retool-exports/retool-db-tables.md.
//
// Two quirks are preserved deliberately rather than corrected, so the types do not lie about what is in
// the database right now:
//   - moderators are recorded by NAME (`createdBy`, `lastUpdateBy`, `handledBy`), not by user id
//   - `TimedMutes.userId` is text while the other tables use integer

// Same definitions prisma-kysely generates for the main schema. `Generated` must unwrap an existing
// ColumnType rather than nest one, or a `Generated<Timestamp>` column selects as ColumnType, not Date.
type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** Free-text moderator notes per user, plus two flags that act as moderation state. */
export type UserNotes = {
  id: Generated<number>;
  userId: number | null;
  notes: string | null;
  lastUpdate: Timestamp | null;
  /** Moderator NAME, not an id. */
  lastUpdateBy: string | null;
  spamWhitelist: boolean | null;
  deservedMute: boolean | null;
};

/** The strike system. No equivalent exists in Civitai's schema. */
export type UserStrikes = {
  id: Generated<number>;
  userId: number | null;
  createdAt: Generated<Timestamp>;
  /** Moderator NAME, not an id. */
  createdBy: string | null;
  reason: string | null;
};

/** Scheduled mutes with an expiry. Empty as of 2026-08-06 — confirm it is still in use. */
export type TimedMutes = {
  id: Generated<number>;
  /** TEXT here, integer in UserNotes/UserStrikes. Cast on migration. */
  userId: string | null;
  muteStart: Timestamp | null;
  muteEnd: Timestamp | null;
  createdBy: string | null;
  createdAt: Generated<Timestamp>;
  muteReason: string | null;
  isMuted: boolean | null;
};

/** Queue for asking another moderator to second-opinion a set of images. */
export type ModerationImageHelp = {
  id: Generated<number>;
  createdBy: string | null;
  /** jsonb array of image ids. */
  imageIds: unknown;
  type: string | null;
  createdAt: Generated<Timestamp>;
  isHandled: boolean | null;
  handledBy: string | null;
  handledAt: Timestamp | null;
};

/**
 * How far each queue has been swept. Retool wrote a row per acknowledgement — a moderator pressing a
 * button to say "I have worked this queue up to now" — and read the newest back as the board's
 * "N behind" indicator. It is a coordination signal between moderators, NOT a job schedule: nothing
 * runs on a timer, and the export contains no Timer plugin at all.
 */
export type Mods_TaskTimers = {
  id: Generated<number>;
  task: string | null;
  lastUpdate: Generated<Timestamp>;
  lastUpdateBy: string | null;
};

/**
 * The front-page rating sweep's shared resume point. `username` is not always a person: the row
 * `splitQueue` marks where the queue was forked into a current and a catch-up stream, which is what
 * the board's Split control writes. `nsfw` holds a browsing-level digit as TEXT.
 */
export type FrontPageTimers = {
  id: Generated<number>;
  username: string | null;
  nsfw: string | null;
  lastCheckedAt: Timestamp | null;
  buttonPressedTime: Timestamp | null;
};

/**
 * Hashes of files from models that were taken down, so the same file is recognisable if re-uploaded.
 * Column names are Retool's, verified against the live table — the export's BULK_INSERT carried an
 * empty changeset and could not say.
 */
export type ModerationSHA = {
  id: Generated<number>;
  SHA256: string | null;
  ModelVersionId: number | null;
};

/**
 * Retool's own action log. Free text with no foreign keys — the user id is embedded in `ActionType`
 * and queried with LIKE. Read-only archive; new activity belongs in ModActivity.
 */
export type ReToolActions = {
  id: Generated<number>;
  Event: Generated<Timestamp>;
  User: string | null;
  App: string | null;
  ActionType: string | null;
};

export type ModeratorDB = {
  UserNotes: UserNotes;
  UserStrikes: UserStrikes;
  TimedMutes: TimedMutes;
  ModerationImageHelp: ModerationImageHelp;
  Mods_TaskTimers: Mods_TaskTimers;
  FrontPageTimers: FrontPageTimers;
  /** Same shape; the catch-up stream's resume point is a separate table, as Retool had it. */
  FrontPageTimers_catchup: FrontPageTimers;
  ModerationSHA: ModerationSHA;
  ReToolActions: ReToolActions;
};
