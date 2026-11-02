import { Prisma } from '@prisma/client';
import { OWNED_REPORT_TABLES } from '@civitai/shared/report-subjects';
import { dbWrite } from '~/server/db/client';

const ident = (name: string) => Prisma.raw(`"${name}"`);

/**
 * Whether a report is about this account: the owner of the reported row, the reported account, or the
 * one other member of a reported two-party chat. False for a report type it cannot resolve.
 */
export async function reportConcernsUser(reportId: number, userId: number): Promise<boolean> {
  const owned = OWNED_REPORT_TABLES.map(
    ({ reportTable, fk, table, ownerColumn }) => Prisma.sql`EXISTS (
      SELECT 1 FROM ${ident(reportTable)} x JOIN ${ident(table)} t ON t.id = x.${ident(fk)}
      WHERE x."reportId" = r.id AND t.${ident(ownerColumn)} = ${userId}
    )`
  );
  // The chat arm mirrors the moderator app's `chatReportSubject`: a chat report names a conversation,
  // so its subject is the one member who is not a reporter, and only in a two-party chat the reporter
  // belongs to. Without the reporter-is-a-member clause, automated reports (filed by an account in no
  // chat) would match both parties.
  const [row] = await dbWrite.$queryRaw<{ concerns: boolean }[]>`
    SELECT (
      ${Prisma.join(owned, ' OR ')}
      OR EXISTS (SELECT 1 FROM "UserReport" ur WHERE ur."reportId" = r.id AND ur."userId" = ${userId})
      OR EXISTS (
        SELECT 1 FROM "ChatReport" cr
        WHERE cr."reportId" = r.id
          AND r."userId" <> ${userId}
          AND NOT (${userId} = ANY(r."alsoReportedBy"))
          AND EXISTS (
            SELECT 1 FROM "ChatMember" cm WHERE cm."chatId" = cr."chatId" AND cm."userId" = ${userId}
          )
          AND EXISTS (
            SELECT 1 FROM "ChatMember" rm WHERE rm."chatId" = cr."chatId" AND rm."userId" = r."userId"
          )
          AND (SELECT count(*) FROM "ChatMember" cm2 WHERE cm2."chatId" = cr."chatId") = 2
      )
    ) AS concerns
    FROM "Report" r
    WHERE r.id = ${reportId}
  `;
  return row?.concerns === true;
}
