import { TRPCError } from '@trpc/server';

import {
  platformUpdateAppSchema,
  pushPlatformUpdateSchema,
  resolvePlatformUpdateSchema,
  supersedePlatformUpdateSchema,
  verifyPlatformUpdateCommitSchema,
  type PushPlatformUpdateInput,
} from '~/server/schema/blocks/app-platform-update.schema';
import type { PlatformUpdateChange } from '~/server/services/blocks/app-source-repo.plan';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * STAFF PLATFORM UPDATES (`app-platform-update.service.ts`).
 *
 * Owner half — `listPending`, `verifyCommit`, `resolve` — is what `civitai app pull` / submit and
 * the App Assistant runner call. `AppBlocksSubmit`, the bit the CLI's other app commands require
 * (see `blocks.getMyForgejoCloneInfo`), so the CLI's OAuth login token reaches them; the service
 * then requires edit access to the app (owner or ACCEPTED collaborator, no moderator bypass). Unlike
 * that procedure there is no developer-terms check: these read and report on the caller's own app
 * and mint no credential.
 *
 * Staff half — `push`, `supersede`, `modList` — is `moderatorProcedure` (session or Full personal
 * key only), and carries no scope annotation: a scoped token must never carry moderator reach.
 *
 * DARK: with the `app-blocks-platform-updates` flag off (or Apps off for the caller), the owner
 * queries answer "no updates" — so a CLI that asks on every pull keeps working — and every
 * mutation refuses.
 */

const cliScope = { requiredScope: TokenScope.AppBlocksSubmit } as const;

const svc = () => import('~/server/services/blocks/app-platform-update.service');

const NOT_ENABLED = () =>
  new TRPCError({ code: 'FORBIDDEN', message: 'Platform updates are not enabled' });

type OwnerCtx = { features?: { appBlocks?: boolean } };

/**
 * Whether the owner half answers for this caller at all. A banned account never gets here:
 * `protectedProcedure`'s `isAuthed` refuses it first.
 */
async function ownerEnabled(ctx: OwnerCtx): Promise<boolean> {
  if (!ctx.features?.appBlocks) return false;
  return (await svc()).isPlatformUpdatesEnabled();
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function toChanges(input: PushPlatformUpdateInput['changes']): PlatformUpdateChange[] {
  return input.map((c): PlatformUpdateChange => {
    if (c.operation === 'delete') return { operation: 'delete', path: c.path };
    if (c.encoding === 'base64' && !BASE64_RE.test(c.content))
      throw new TRPCError({ code: 'BAD_REQUEST', message: `${c.path}: content is not base64` });
    return {
      operation: 'put',
      path: c.path,
      content: Buffer.from(c.content, c.encoding === 'base64' ? 'base64' : 'utf8'),
    };
  });
}

export const appPlatformUpdatesRouter = router({
  /** The app's pending platform updates, oldest first. */
  listPending: protectedProcedure
    .meta(cliScope)
    .input(platformUpdateAppSchema)
    .query(async ({ ctx, input }) => {
      if (!(await ownerEnabled(ctx))) return { updates: [] };
      const { listPendingPlatformUpdates } = await svc();
      return {
        updates: await listPendingPlatformUpdates({
          userId: ctx.user.id,
          app: { appBlockId: input.appBlockId, slug: input.slug },
        }),
      };
    }),

  /** Is this commit a platform update the server recorded? The only source of "verified staff". */
  verifyCommit: protectedProcedure
    .meta(cliScope)
    .input(verifyPlatformUpdateCommitSchema)
    .query(async ({ ctx, input }) => {
      if (!(await ownerEnabled(ctx))) return { verified: false, update: null };
      const { verifyPlatformUpdateCommit } = await svc();
      return verifyPlatformUpdateCommit({
        userId: ctx.user.id,
        app: { appBlockId: input.appBlockId, slug: input.slug },
        commitSha: input.commitSha,
      });
    }),

  /** The owner's client reports an update merged (with the merge commit) or conflicted. */
  resolve: protectedProcedure
    .meta(cliScope)
    .input(resolvePlatformUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      if (!(await ownerEnabled(ctx))) throw NOT_ENABLED();
      const { resolvePlatformUpdate } = await svc();
      return {
        update: await resolvePlatformUpdate({
          userId: ctx.user.id,
          id: input.id,
          outcome: input.outcome,
          mergeCommitSha: input.mergeCommitSha ?? null,
        }),
      };
    }),

  /** Staff: commit a change to an app's source repo as a platform update, and tell its owner. */
  push: moderatorProcedure.input(pushPlatformUpdateSchema).mutation(async ({ ctx, input }) => {
    const { isPlatformUpdatesEnabled, pushPlatformUpdate } = await svc();
    if (!(await isPlatformUpdatesEnabled())) throw NOT_ENABLED();
    return pushPlatformUpdate({
      staffUserId: ctx.user.id,
      app: { appBlockId: input.appBlockId, slug: input.slug },
      reason: input.reason,
      changes: toChanges(input.changes),
    });
  }),

  /** Staff: withdraw a pending or conflicted update. */
  supersede: moderatorProcedure
    .input(supersedePlatformUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const { isPlatformUpdatesEnabled, supersedePlatformUpdate } = await svc();
      if (!(await isPlatformUpdatesEnabled())) throw NOT_ENABLED();
      return supersedePlatformUpdate({ staffUserId: ctx.user.id, id: input.id });
    }),

  /** Staff: every update to an app, newest first. */
  modList: moderatorProcedure.input(platformUpdateAppSchema).query(async ({ input }) => {
    const { isPlatformUpdatesEnabled, listPlatformUpdatesForModerator } = await svc();
    if (!(await isPlatformUpdatesEnabled())) return { updates: [] };
    return {
      updates: await listPlatformUpdatesForModerator({
        app: { appBlockId: input.appBlockId, slug: input.slug },
      }),
    };
  }),
});
