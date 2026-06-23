import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { protectedProcedure, router } from '~/server/trpc';
import { dbRead, dbWrite } from '~/server/db/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { buzzLimitSchema, type BuzzLimit } from '~/server/schema/api-key.schema';
import { bustBuzzLimitCache, deleteAuthSubject } from '~/server/http/orchestrator/api-key-spend';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { logToAxiom, safeError } from '~/server/logging/client';
import * as z from 'zod';

export const oauthConsentRouter = router({
  // Get all apps the user has authorized (connected apps)
  getConnectedApps: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(async ({ ctx }) => {
      const consents = await dbRead.oauthConsent.findMany({
        where: { userId: ctx.user.id },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              description: true,
              logoUrl: true,
              isVerified: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return consents.map((consent) => ({
        clientId: consent.clientId,
        name: consent.client.name,
        description: consent.client.description,
        logoUrl: consent.client.logoUrl,
        isVerified: consent.client.isVerified,
        scope: consent.scope,
        buzzLimit: consent.buzzLimit as BuzzLimit | null,
        authorizedAt: consent.createdAt,
      }));
    }),

  // Set or clear the buzz spend limit for a connected app. The limit lives on
  // the consent so it persists across access-token rotations — refresh-issued
  // tokens for the same consent inherit it automatically.
  setBuzzLimit: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(
      z.object({
        clientId: z.string(),
        buzzLimit: buzzLimitSchema.nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Self-modify guard: an OAuth-issued token must not be able to raise or
      // clear the limit on the consent it was issued under. Session auth is
      // unaffected.
      const subject = (
        ctx as unknown as {
          subject?: { type: string; id: number | string } | null;
        }
      ).subject;
      if (subject && subject.type === 'oauth' && subject.id === input.clientId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'An OAuth token cannot modify its own consent spend limit. Use a different key or session auth.',
        });
      }

      const consent = await dbWrite.oauthConsent.findUnique({
        where: { userId_clientId: { userId: ctx.user.id, clientId: input.clientId } },
        select: { id: true },
      });
      if (!consent) throw new TRPCError({ code: 'NOT_FOUND' });

      await dbWrite.oauthConsent.update({
        where: { userId_clientId: { userId: ctx.user.id, clientId: input.clientId } },
        data: { buzzLimit: input.buzzLimit ?? Prisma.DbNull },
      });

      // Best-effort bust-cache. The orchestrator caches limits by (type, id);
      // for OAuth grants the id is the clientId (stable across access-token
      // rotations). Failure is logged but doesn't fail the user mutation.
      try {
        await bustBuzzLimitCache({
          userId: ctx.user.id,
          subject: { type: 'oauth', id: input.clientId },
        });
      } catch (err) {
        logToAxiom({
          type: 'oauth.bust-cache.failed',
          message: `bust-cache failed for oauth client ${input.clientId} user ${ctx.user.id}`,
          error: safeError(err),
        }).catch(() => {});
      }

      // Audit trail in ClickHouse `actions`. Fire-and-forget.
      ctx.track
        .action({
          type: 'BuzzLimit_Set',
          details: {
            subjectType: 'oauth',
            subjectId: input.clientId,
            buzzLimit: input.buzzLimit,
            viaSubject: (ctx as unknown as { subject?: unknown }).subject ?? null,
          },
        })
        .catch(() => {});

      return { success: true, buzzLimit: input.buzzLimit };
    }),

  // Revoke access for a connected app (delete all tokens + consent)
  revokeApp: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(z.object({ clientId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const consent = await dbWrite.oauthConsent.findUnique({
        where: { userId_clientId: { userId: ctx.user.id, clientId: input.clientId } },
      });
      if (!consent) throw new TRPCError({ code: 'NOT_FOUND' });

      // Delete all tokens for this client+user
      await dbWrite.apiKey.deleteMany({
        where: {
          userId: ctx.user.id,
          clientId: input.clientId,
          type: { in: ['Access', 'Refresh'] },
        },
      });

      // Delete consent record
      await dbWrite.oauthConsent.delete({
        where: { userId_clientId: { userId: ctx.user.id, clientId: input.clientId } },
      });

      // Best-effort: tell the orchestrator the OAuth subject is gone so its
      // stored spend record doesn't linger after the user revokes the app.
      deleteAuthSubject({
        userId: ctx.user.id,
        subject: { type: 'oauth', id: input.clientId },
      }).catch((err) => {
        logToAxiom({
          type: 'oauth.delete-subject.failed',
          message: `delete-subject failed for oauth client ${input.clientId} user ${ctx.user.id}`,
          error: safeError(err),
        }).catch(() => {});
      });

      // Expire the revoked tokens in the orchestrator's auth cache so they
      // stop authenticating immediately instead of lingering until TTL.
      await invalidateCivitaiUser({ userId: ctx.user.id });

      logOAuthEvent({
        type: 'authorization.denied',
        userId: ctx.user.id,
        clientId: input.clientId,
        metadata: { action: 'revoked_by_user' },
      });

      return { success: true };
    }),

  // (the limit-set audit fire is added on `setBuzzLimit` below)
});
