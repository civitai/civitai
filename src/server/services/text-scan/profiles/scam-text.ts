import { decode } from 'he';
import { dbWrite } from '~/server/db/client';
import {
  scamAccountAgeCutoff,
  scamMuteIneligibility,
} from '~/server/services/scam-auto-mute.constants';
import type { TextScanField, TextScanSubject } from '~/server/services/text-scan/types';
import { PROTECTED_USER_IDS } from '~/server/utils/protected-user-ids';
import { removeTags } from '~/utils/string-helpers';

const ANCHOR_HREF = /<a\b[^<>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))[^<>]*>/gi;

/** Rich text as plain text, keeping link targets that exist only in an `href`. */
export function scamTextFromHtml(html: string | null | undefined) {
  if (!html) return '';
  const stripped = removeTags(
    html.replace(
      ANCHOR_HREF,
      (_tag, dq?: string, sq?: string, bare?: string) => ` [link: ${dq ?? sq ?? bare}] `
    )
  );
  return decode(stripped);
}

export function scamSubject(
  userId: number,
  fields: TextScanField[],
  meta: Record<string, unknown> = {}
): TextScanSubject {
  return { fields, declared: {}, userId, meta: { ...meta, subjectUserId: userId } };
}

export function scamSubjectText(subject: TextScanSubject) {
  return subject.fields
    .map((field) => field.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

/**
 * The authors a scam verdict could act on. Everyone else is dropped before submit, so their text
 * costs nothing and leaves no row. Challenge judges are dropped here only: their comments are
 * automated, and a verdict can reach an account only through text that was submitted.
 */
export async function scamEligibleAuthors(
  userIds: number[],
  { ignoreAccountAge = false }: { ignoreAccountAge?: boolean } = {}
) {
  const ids = [...new Set(userIds)].filter((id) => id > 0 && !PROTECTED_USER_IDS.has(id));
  if (!ids.length) return new Set<number>();

  const now = new Date();
  const [users, judges] = await Promise.all([
    dbWrite.user.findMany({
      where: {
        id: { in: ids },
        ...(ignoreAccountAge ? {} : { createdAt: { gt: scamAccountAgeCutoff(now) } }),
      },
      select: { id: true, createdAt: true, isModerator: true, deletedAt: true, bannedAt: true },
    }),
    dbWrite.challengeJudge.findMany({ where: { userId: { in: ids } }, select: { userId: true } }),
  ]);
  const judgeIds = new Set(judges.map((judge) => judge.userId));
  return new Set(
    users
      .filter((u) => !judgeIds.has(u.id) && !scamMuteIneligibility(u, { ignoreAccountAge, now }))
      .map((u) => u.id)
  );
}
