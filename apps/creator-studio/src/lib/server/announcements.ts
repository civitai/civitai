import type { SessionUser } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import { dbRead } from '$lib/server/db';
import { getFlipt } from '$lib/server/flipt';
import type { AnnouncementAllowance } from '$lib/announcements';
import type { AnnouncementForm } from './announcements-schema';

// Announcement writes go through the MAIN APP, not kysely: the allowance check, the creator/sitewide
// boundary and the cover `Image` row are all owned there, and duplicating any of them here would put a
// second copy of the security-shaped code in a second app. We POST to its REST endpoints forwarding the
// caller's shared .civitai.com session cookie, exactly as paid-access.ts does.
const MAIN_APP_URL = env.CIVITAI_APP_URL || 'https://civitai.com';

export const ANNOUNCEMENTS_FLAG = 'creator-announcements';

/**
 * 🔴 Must stay the same key AND the same Flipt-down posture as the main app's
 * `creatorAnnouncements` feature flag (availability ['mod'] + fliptKey). One flag drives both apps;
 * an app that fails to a different answer produces the half-visible state the single flag exists to
 * prevent. `getClientSync()` is null only when the client never initialised, which is what separates
 * "Flipt says off" from "Flipt is unreachable".
 */
export async function announcementsEnabled(user: SessionUser): Promise<boolean> {
  const flipt = getFlipt();
  if (await flipt.isEnabled(ANNOUNCEMENTS_FLAG, String(user.id))) return true;
  return flipt.getClientSync() === null && user.isModerator === true;
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
      domain: row.domain as string[],
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

export type AnnouncementResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: string };

async function callMainApp<T>(
  path: string,
  cookie: string,
  init?: { method?: string; body?: unknown }
): Promise<AnnouncementResult<T>> {
  try {
    const res = await fetch(`${MAIN_APP_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json', cookie },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (res.ok) return { ok: true, data: (await res.json()) as T };

    const data = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    return {
      ok: false,
      status: res.status,
      error: data?.error ?? data?.message ?? `Request failed (${res.status}).`,
    };
  } catch {
    return {
      ok: false,
      status: 502,
      error: 'Could not reach the announcement service. Please try again.',
    };
  }
}

const ENDPOINT = '/api/v1/announcements';

export function getAllowance(cookie: string) {
  return callMainApp<AnnouncementAllowance>(ENDPOINT, cookie);
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
