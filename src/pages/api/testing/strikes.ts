import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import {
  createStrike,
  evaluateStrikeEscalation,
  expireStrikes,
  getActiveStrikePoints,
  getStrikesForUser,
  processTimedUnmutes,
  shouldRateLimitStrike,
  voidStrike,
  type EscalationAction,
} from '~/server/services/strike.service';
import type { UserMeta } from '~/server/schema/user.schema';
import { StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z
  .object({
    action: z.enum([
      'get-user-strikes',
      'get-active-points',
      'check-rate-limit',
      'evaluate-escalation',
      'create',
      'void',
      'expire',
      'unmute',
    ]),
    userId: z.coerce.number().optional(),
    reason: z.string().optional(),
    points: z.coerce.number().optional(),
    description: z.string().optional(),
    internalNotes: z.string().optional(),
    expiresInDays: z.coerce.number().optional(),
    strikeId: z.coerce.number().optional(),
    voidReason: z.string().optional(),
    includeExpired: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    dryRun: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
  .superRefine((data, ctx) => {
    const userActions = [
      'get-user-strikes',
      'get-active-points',
      'check-rate-limit',
      'evaluate-escalation',
      'create',
    ];
    if (userActions.includes(data.action) && !data.userId) {
      ctx.addIssue({
        code: 'custom',
        message: `userId is required for action "${data.action}"`,
      });
    }

    if (data.action === 'create') {
      if (!data.reason) {
        ctx.addIssue({ code: 'custom', message: 'reason is required for action "create"' });
      }
      if (!data.description) {
        ctx.addIssue({ code: 'custom', message: 'description is required for action "create"' });
      }
    }

    if (data.action === 'void' && !data.strikeId) {
      ctx.addIssue({ code: 'custom', message: 'strikeId is required for action "void"' });
    }
  });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.parse(req.query);
  const { action, userId, dryRun } = payload;

  // ── Read-only actions ──────────────────────────────────────────────
  if (action === 'get-user-strikes') {
    const result = await getStrikesForUser(userId!, {
      includeExpired: payload.includeExpired,
      includeInternalNotes: true,
    });
    return res.status(200).json({ action, userId, ...result });
  }

  if (action === 'get-active-points') {
    const points = await getActiveStrikePoints(userId!);
    return res.status(200).json({ action, userId, activePoints: points });
  }

  if (action === 'check-rate-limit') {
    const limited = await shouldRateLimitStrike(userId!);
    return res.status(200).json({ action, userId, isRateLimited: limited });
  }

  // ── Evaluate escalation ────────────────────────────────────────────
  if (action === 'evaluate-escalation') {
    if (dryRun) {
      const totalPoints = await getActiveStrikePoints(userId!);
      const user = await dbRead.user.findUnique({
        where: { id: userId! },
        select: { muted: true, muteExpiresAt: true, meta: true },
      });

      let predictedAction: EscalationAction = 'none';
      if (user) {
        const currentMeta = (user.meta as UserMeta) ?? {};
        if (totalPoints >= 3) {
          predictedAction = 'muted-and-flagged';
        } else if (totalPoints >= 2) {
          predictedAction = 'muted';
        } else if (
          user.muted &&
          (user.muteExpiresAt !== null || currentMeta.strikeFlaggedForReview)
        ) {
          predictedAction = 'unmuted';
        }
      }

      return res.status(200).json({
        action,
        dryRun: true,
        userId,
        totalPoints,
        currentState: user
          ? { muted: user.muted, muteExpiresAt: user.muteExpiresAt, meta: user.meta }
          : null,
        predictedAction,
      });
    }

    const result = await evaluateStrikeEscalation(userId!);
    return res
      .status(200)
      .json({ action, userId, totalPoints: result.totalPoints, escalationAction: result.action });
  }

  // ── Create strike ──────────────────────────────────────────────────
  if (action === 'create') {
    if (dryRun) {
      const user = await dbRead.user.findUnique({
        where: { id: userId! },
        select: { id: true, username: true },
      });
      if (!user) return res.status(404).json({ error: `User ${userId} not found` });

      const reason = payload.reason as StrikeReason;
      let isRateLimited = false;
      if (reason !== StrikeReason.ManualModAction) {
        isRateLimited = await shouldRateLimitStrike(userId!);
      }

      const expiresInDays = payload.expiresInDays ?? 30;
      const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

      return res.status(200).json({
        action,
        dryRun: true,
        userId,
        user,
        wouldCreate: {
          reason,
          points: payload.points ?? 1,
          description: payload.description,
          internalNotes: payload.internalNotes,
          expiresAt,
          expiresInDays,
        },
        isRateLimited,
        wouldBeSkipped: isRateLimited,
      });
    }

    const strike = await createStrike({
      userId: userId!,
      reason: payload.reason as StrikeReason,
      points: payload.points ?? 1,
      description: payload.description!,
      internalNotes: payload.internalNotes,
      expiresInDays: payload.expiresInDays ?? 30,
    });
    return res.status(200).json({ action, strike });
  }

  // ── Void strike ────────────────────────────────────────────────────
  if (action === 'void') {
    if (dryRun) {
      const strike = await dbRead.userStrike.findUnique({
        where: { id: payload.strikeId! },
        select: {
          id: true,
          userId: true,
          status: true,
          reason: true,
          points: true,
          createdAt: true,
          expiresAt: true,
        },
      });
      if (!strike) return res.status(404).json({ error: `Strike ${payload.strikeId} not found` });

      return res.status(200).json({
        action,
        dryRun: true,
        strike,
        canVoid: strike.status === StrikeStatus.Active,
        currentStatus: strike.status,
      });
    }

    const strike = await voidStrike({
      strikeId: payload.strikeId!,
      voidReason: payload.voidReason ?? 'Voided via test endpoint',
      voidedBy: -1, // System
    });
    return res.status(200).json({ action, strike });
  }

  // ── Expire strikes ─────────────────────────────────────────────────
  if (action === 'expire') {
    if (dryRun) {
      const strikesToExpire = await dbRead.userStrike.findMany({
        where: {
          status: StrikeStatus.Active,
          expiresAt: { lte: new Date() },
        },
        select: { id: true, userId: true, points: true, expiresAt: true },
      });
      const affectedUserIds = [...new Set(strikesToExpire.map((s) => s.userId))];

      return res.status(200).json({
        action,
        dryRun: true,
        strikesToExpire,
        affectedUserIds,
        count: strikesToExpire.length,
      });
    }

    const result = await expireStrikes();
    return res.status(200).json({ action, ...result });
  }

  // ── Process timed unmutes ──────────────────────────────────────────
  if (action === 'unmute') {
    if (dryRun) {
      const usersWithExpiredMutes = await dbRead.user.findMany({
        where: {
          muted: true,
          muteExpiresAt: { not: null, lte: new Date() },
        },
        select: { id: true, username: true, muteExpiresAt: true },
      });

      const predictions = await Promise.all(
        usersWithExpiredMutes.map(async (u) => {
          const totalPoints = await getActiveStrikePoints(u.id);
          let predictedAction: EscalationAction = 'none';
          if (totalPoints >= 3) predictedAction = 'muted-and-flagged';
          else if (totalPoints >= 2) predictedAction = 'muted';
          else predictedAction = 'unmuted';

          return {
            userId: u.id,
            username: u.username,
            muteExpiresAt: u.muteExpiresAt,
            activePoints: totalPoints,
            predictedAction,
            wouldUnmute: predictedAction === 'unmuted',
          };
        })
      );

      return res.status(200).json({
        action,
        dryRun: true,
        usersWithExpiredMutes: predictions,
        count: predictions.length,
        wouldUnmuteCount: predictions.filter((p) => p.wouldUnmute).length,
      });
    }

    const result = await processTimedUnmutes();
    return res.status(200).json({ action, ...result });
  }

  return res.status(400).json({ error: 'Unknown action' });
});
