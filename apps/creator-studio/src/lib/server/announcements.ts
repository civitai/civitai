import type { SessionUser } from '@civitai/auth';
import { dbRead } from '$lib/server/db';
import { callMainApp, type MainAppResult } from '$lib/server/main-app';
import { modFallbackFlagEnabled } from '$lib/server/main-app-flags';
import {
  toAnnouncementLinks,
  toDomainArray,
  type AnnouncementAllowance,
  type AnnouncementLink,
} from '$lib/announcements';
import { allowanceSchema, toSaveBody, type AnnouncementForm } from './announcements-schema';

// Announcement writes go through the MAIN APP, not kysely: the allowance check, the creator/sitewide
// boundary and the cover `Image` row are all owned there, and duplicating any of them here would put a
// second copy of the security-shaped code in a second app.

export const ANNOUNCEMENTS_FLAG = 'creator-announcements';

// 🔴 Must stay the main app's `creatorAnnouncements` fliptKey.
export function announcementsEnabled(user: SessionUser): Promise<boolean> {
  return modFallbackFlagEnabled(ANNOUNCEMENTS_FLAG, user);
}

export type AnnouncementRow = {
  id: number;
  title: string;
  content: string;
  domain: string[];
  startsAt: Date | null;
  endsAt: Date | null;
  disabled: boolean;
  profileOnly: boolean;
  createdAt: Date;
  coverUrl: string | null;
  /** A slot was spent on this announcement — deleting it does not give the slot back. */
  spentSlot: boolean;
  coverNsfwLevel: number | null;
  links: AnnouncementLink[];
};

/** The caller's own announcements. Owner-scoped and never `userId is null`, so a platform row is unreachable. */
export async function getMyAnnouncements(userId: number): Promise<AnnouncementRow[]> {
  const rows = await dbRead
    .selectFrom('Announcement as a')
    .leftJoin('Image as i', 'i.id', 'a.coverId')
    .where('a.userId', '=', userId)
    .select((eb) => [
      eb
        .exists(
          eb
            .selectFrom('AnnouncementSpend as s')
            .select('s.id')
            .whereRef('s.announcementId', '=', 'a.id')
        )
        .as('spentSlot'),
      'a.id',
      'a.title',
      'a.content',
      'a.domain',
      'a.startsAt',
      'a.endsAt',
      'a.disabled',
      'a.profileOnly',
      'a.createdAt',
      'a.metadata',
      'i.url as coverUrl',
      'i.nsfwLevel as coverNsfwLevel',
    ])
    .orderBy('a.createdAt', 'desc')
    .limit(50)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    domain: toDomainArray(row.domain),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    disabled: row.disabled,
    profileOnly: row.profileOnly,
    createdAt: row.createdAt,
    spentSlot: row.spentSlot === true,
    coverUrl: row.coverUrl ?? null,
    coverNsfwLevel: row.coverNsfwLevel ?? null,
    links: toAnnouncementLinks(row.metadata),
  }));
}

const ENDPOINT = '/api/v1/announcements';

export async function getAllowance(cookie: string): Promise<MainAppResult<AnnouncementAllowance>> {
  const result = await callMainApp<unknown>(ENDPOINT, cookie);
  if (!result.ok) return result;

  const parsed = allowanceSchema.safeParse(result.data);
  if (!parsed.success)
    return {
      ok: false,
      status: 502,
      error: 'The announcement service returned an unreadable allowance.',
    };

  return { ok: true, data: parsed.data };
}

export function saveAnnouncement(cookie: string, form: AnnouncementForm) {
  return callMainApp<{ id: number }>(ENDPOINT, cookie, {
    method: 'POST',
    body: toSaveBody(form),
  });
}

export function removeAnnouncement(cookie: string, id: number) {
  return callMainApp<{ id: number }>(ENDPOINT, cookie, {
    method: 'DELETE',
    body: { id },
  });
}

/**
 * Mints a presigned cover upload through the main app.
 *
 * 🔴 Do not mint one from here instead. That endpoint also registers the object key with the
 * storage-resolver; a key minted anywhere else uploads fine and then never resolves for the edge
 * URL or the image scanner — a silent permanent 404.
 */
export function createCoverUpload(cookie: string) {
  return callMainApp<{ id: string; uploadURL: string }>('/api/v1/image-upload', cookie, {
    method: 'POST',
  });
}
