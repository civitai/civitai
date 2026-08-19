import type { SessionUser } from '@civitai/auth';
import { dbRead } from '$lib/server/db';
import { callMainApp, type MainAppResult } from '$lib/server/main-app';
import { getFlipt } from '$lib/server/flipt';
import type { AnnouncementAllowance } from '$lib/announcements';
import { allowanceSchema, type AnnouncementForm } from './announcements-schema';

// Announcement writes go through the MAIN APP, not kysely: the allowance check, the creator/sitewide
// boundary and the cover `Image` row are all owned there, and duplicating any of them here would put a
// second copy of the security-shaped code in a second app.

export const ANNOUNCEMENTS_FLAG = 'creator-announcements';

/**
 * 🔴 Must stay the same key AND the same Flipt-down posture as the main app's
 * `creatorAnnouncements` feature flag (availability ['mod'] + fliptKey). One flag drives both apps;
 * an app that fails to a different answer produces the half-visible state the single flag exists to
 * prevent.
 *
 * The fallback keys on a null EVALUATION, not on the client being absent: `isEnabledSync` returns
 * null for an unreachable client and for a flag that does not exist yet, which is the normal state
 * of a feature that ships dark. `isEnabled` would collapse both to false and lock moderators out of
 * a page the main app is already showing them.
 */
export async function announcementsEnabled(user: SessionUser): Promise<boolean> {
  const flipt = getFlipt();
  await flipt.ensureInitialized();

  const evaluated = flipt.isEnabledSync(ANNOUNCEMENTS_FLAG, String(user.id));
  return evaluated ?? user.isModerator === true;
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
  coverNsfwLevel: number | null;
  link: string | null;
  linkText: string | null;
};

type AnnouncementMetadata = { actions?: { link?: string; linkText?: string }[] } | null;

/** The caller's own announcements. Owner-scoped and never `userId is null`, so a platform row is unreachable. */
export async function getMyAnnouncements(userId: number): Promise<AnnouncementRow[]> {
  const rows = await dbRead
    .selectFrom('Announcement as a')
    .leftJoin('Image as i', 'i.id', 'a.coverId')
    .where('a.userId', '=', userId)
    .select([
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

  return rows.map((row) => {
    const action = (row.metadata as AnnouncementMetadata)?.actions?.[0];
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      domain: [...new Set(row.domain as string[])],
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      disabled: row.disabled,
      profileOnly: row.profileOnly,
      createdAt: row.createdAt,
      coverUrl: row.coverUrl ?? null,
      coverNsfwLevel: row.coverNsfwLevel ?? null,
      link: action?.link ?? null,
      linkText: action?.linkText ?? null,
    };
  });
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
    body: {
      id: form.id,
      title: form.title,
      content: form.content,
      domain: form.domain,
      profileOnly: form.profileOnly,
      // Round-tripped, not defaulted: the endpoint writes `disabled: input.disabled ?? false`, so
      // omitting it would silently republish an announcement a moderator had taken down.
      disabled: form.disabled,
      startsAt: form.startsAt?.toISOString() ?? null,
      endsAt: form.endsAt?.toISOString() ?? null,
      ...(form.linkUrl && form.linkText
        ? { action: { link: form.linkUrl, linkText: form.linkText } }
        : {}),
      // A key, never an `Image` id: the server mints the row so the cover gets ingested and scanned.
      ...(form.coverKey
        ? {
            coverImage: {
              url: form.coverKey,
              width: form.coverWidth,
              height: form.coverHeight,
              mimeType: form.coverMimeType,
              sizeKB: form.coverSizeKB,
            },
          }
        : {}),
    },
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
