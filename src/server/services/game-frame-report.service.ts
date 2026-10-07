import type { Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { createReport, findReportToFoldInto } from '~/server/services/report.service';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

const REPORT_LOCK_CLASS = 0x47460001;
const GAME_LOCK_CLASS = 0x47460002;
const MAX_GUEST_ENTRIES = 50;

export const gameFrameSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);

export const gameFrameGameSchema = z.object({
  slug: gameFrameSlugSchema,
  title: z.string().min(1).max(120),
  authorUserId: z.number().int().positive().nullable(),
  official: z.boolean(),
  visibility: z.enum(['public', 'private', 'delisted']),
  url: z.url({ protocol: /^https$/ }),
  coverUrl: z.url({ protocol: /^https$/ }).nullable(),
});
export type GameFrameGameInput = z.infer<typeof gameFrameGameSchema>;

export const GF_REASONS = {
  minors: { reason: ReportReason.TOSViolation, violation: 'Child abuse and exploitation' },
  adult: { reason: ReportReason.NSFW, violation: undefined },
  real_person: {
    reason: ReportReason.TOSViolation,
    violation: 'Depiction of real-person likeness',
    commentRequired: true,
  },
  hate: { reason: ReportReason.TOSViolation, violation: 'Hate or harassment' },
  violence: { reason: ReportReason.TOSViolation, violation: 'Graphic violence' },
  spam: { reason: ReportReason.Spam, violation: undefined },
  other: { reason: ReportReason.TOSViolation, violation: 'Other', commentRequired: true },
} as const satisfies Record<
  string,
  { reason: ReportReason; violation: string | undefined; commentRequired?: boolean }
>;
type GfReason = keyof typeof GF_REASONS;

export const gameFrameReportSchema = z
  .object({
    gfReportId: z.string().regex(/^gr_[0-9A-HJKMNP-TV-Z]{26}$/),
    at: z.iso.datetime(),
    game: gameFrameGameSchema,
    reporter: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('user'), userId: z.number().int().positive() }),
      // `u` + 11 hex is Game Frame's retry of an unknown_user report as a guest (contract B.3).
      z.object({
        kind: z.literal('guest'),
        guestKey: z.string().regex(/^(?:[0-9a-f]{12}|u[0-9a-f]{11})$/),
      }),
    ]),
    gfReason: z.enum(Object.keys(GF_REASONS) as [GfReason, ...GfReason[]]),
    reason: z.enum(ReportReason),
    violation: z.string().optional(),
    comment: z.string().max(500),
    room: z.string().max(32).optional(),
  })
  .superRefine((input, ctx) => {
    const expected = GF_REASONS[input.gfReason];
    // The pair is checked rather than derived so a mapping bug on Game Frame's side is refused
    // loudly instead of filed under a reason nobody chose. `minors` as CSAM lands here too.
    if (input.reason !== expected.reason || input.violation !== expected.violation)
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `gfReason ${input.gfReason} must be ${expected.reason}${
          expected.violation ? ` / ${expected.violation}` : ' with no violation'
        }`,
      });
    if ('commentRequired' in expected && expected.commentRequired && !input.comment.trim())
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: `gfReason ${input.gfReason} requires a comment`,
      });
  });
export type GameFrameReportInput = z.infer<typeof gameFrameReportSchema>;

export const gameFrameStateSchema = gameFrameGameSchema.extend({ at: z.iso.datetime() });
export type GameFrameStateInput = z.infer<typeof gameFrameStateSchema>;

export type FileGameFrameReportResult =
  | { ok: true; reportId: number; result: 'created' | 'merged' | 'duplicate' }
  | { ok: false; error: 'unknown_user' };

async function lock(tx: Prisma.TransactionClient, lockClass: number, key: string) {
  // Postgres has no parameter form for SET; a module constant, nothing from the request.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockClass}::int, hashtext(${key}))`;
}

function mirrorFields(game: GameFrameGameInput) {
  return {
    title: game.title,
    userId: game.authorUserId,
    official: game.official,
    visibility: game.visibility,
    url: game.url,
    coverUrl: game.coverUrl,
  };
}

/**
 * Upserts the mirror row. A payload older than the row's last applied one leaves the fields alone,
 * so a report delivered late from Game Frame's outbox cannot undo a newer delist.
 */
async function upsertMirror(tx: Prisma.TransactionClient, game: GameFrameGameInput, at: Date) {
  const row = await tx.gameFrameGame.upsert({
    where: { slug: game.slug },
    create: { slug: game.slug, ...mirrorFields(game), stateAt: at },
    update: {},
    select: { id: true, stateAt: true },
  });
  if (row.stateAt && row.stateAt > at) return row;
  await tx.gameFrameGame.update({
    where: { id: row.id },
    data: { ...mirrorFields(game), stateAt: at },
  });
  return row;
}

async function holdsAuthor(tx: Prisma.TransactionClient, userId: number | null) {
  if (userId == null) return null;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
  return user ? userId : null;
}

function appendGuest(details: Prisma.JsonValue, entry: Record<string, unknown>) {
  const base =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  const prior = Array.isArray(base.guests) ? base.guests : [];
  const count = typeof base.guestCount === 'number' ? base.guestCount : prior.length;
  return {
    ...base,
    guests: [...prior, entry].slice(-MAX_GUEST_ENTRIES),
    guestCount: count + 1,
  } as Prisma.InputJsonValue;
}

export async function fileGameFrameReport(
  input: GameFrameReportInput,
  { guestUserId }: { guestUserId: number }
): Promise<FileGameFrameReportResult> {
  const at = new Date(input.at);

  return dbWrite.$transaction(
    async (tx): Promise<FileGameFrameReportResult> => {
      await lock(tx, REPORT_LOCK_CLASS, input.gfReportId);
      const receipt = await tx.gameFrameReportReceipt.findUnique({
        where: { gfReportId: input.gfReportId },
        select: { reportId: true },
      });
      if (receipt) return { ok: true, reportId: receipt.reportId, result: 'duplicate' };

      await lock(tx, GAME_LOCK_CLASS, input.game.slug);
      // An author id that names no user would fail the mirror's FK; the game is still reportable.
      const game = await upsertMirror(
        tx,
        { ...input.game, authorUserId: await holdsAuthor(tx, input.game.authorUserId) },
        at
      );

      let filer = guestUserId;
      if (input.reporter.kind === 'user') {
        const user = await tx.user.findUnique({
          where: { id: input.reporter.userId },
          select: { deletedAt: true, bannedAt: true, muted: true },
        });
        // The site's own report route refuses banned and muted accounts. unknown_user makes Game
        // Frame refile the report as a guest, so it still reaches a moderator but earns no reward.
        if (!user || user.deletedAt || user.bannedAt || user.muted)
          return { ok: false, error: 'unknown_user' };
        filer = input.reporter.userId;
      }

      const details: Record<string, unknown> = {
        comment: input.comment,
        gfReason: input.gfReason,
        gfReportId: input.gfReportId,
        source: 'game-frame',
        ...(input.violation ? { violation: input.violation } : {}),
        ...(input.room ? { room: input.room } : {}),
      };

      const existing = await findReportToFoldInto({
        reportType: ReportEntity.GameFrameGame,
        entityReportId: game.id,
        reason: input.reason,
        details,
        tx,
      });
      const alreadyHolds =
        !!existing && (existing.userId === filer || existing.alsoReportedBy.includes(filer));

      let report = existing;
      // createReport appends a repeat filer to `alsoReportedBy` (it only checks that list), which
      // would pay them twice on Actioned. A filer already on the report changes nothing on it.
      if (!alreadyHolds) {
        report = await createReport({
          userId: filer,
          id: game.id,
          type: ReportEntity.GameFrameGame,
          reason: input.reason,
          details,
          tx,
        } as Parameters<typeof createReport>[0]);
      }
      if (!report) throw new Error('game-frame report: createReport returned nothing');

      // Every guest files as the one guest account, so without this list a second guest report on
      // the same game would vanish into dedupe as "already reported by".
      if (input.reporter.kind === 'guest') {
        const entry = {
          gfReportId: input.gfReportId,
          guestKey: input.reporter.guestKey,
          gfReason: input.gfReason,
          violation: input.violation,
          comment: input.comment,
          at: input.at,
          room: input.room,
        };
        report = await tx.report.update({
          where: { id: report.id },
          data: { details: appendGuest(report.details, entry) },
        });
      }

      await tx.gameFrameReportReceipt.create({
        data: { gfReportId: input.gfReportId, reportId: report.id },
      });

      return { ok: true, reportId: report.id, result: existing ? 'merged' : 'created' };
    },
    { timeout: 15_000 }
  );
}

/** Applies a state push to an existing mirror row. Never creates one. */
export async function applyGameFrameState(
  input: GameFrameStateInput
): Promise<{ gameId: number } | null> {
  const at = new Date(input.at);
  return dbWrite.$transaction(async (tx) => {
    await lock(tx, GAME_LOCK_CLASS, input.slug);
    const row = await tx.gameFrameGame.findUnique({
      where: { slug: input.slug },
      select: { id: true, stateAt: true },
    });
    if (!row) return null;
    if (row.stateAt && row.stateAt > at) return { gameId: row.id };
    await tx.gameFrameGame.update({
      where: { id: row.id },
      data: {
        ...mirrorFields({
          ...input,
          authorUserId: await holdsAuthor(tx, input.authorUserId),
        }),
        stateAt: at,
      },
    });
    return { gameId: row.id };
  });
}
