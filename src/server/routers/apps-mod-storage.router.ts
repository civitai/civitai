// App Blocks — MODERATOR surface for PER-USER App Storage (`trpc.apps.mod.userStorage.*`).
//
// Session `moderatorProcedure`, NOT block-token reachable: this is a takedown
// path, not something an app can ask for. Three procedures, in the order they
// are meant to be used:
//
//   preview      — see exactly what a purge would remove, for one app or for
//                  the whole account. READ ONLY.
//   purgeApp     — remove one user's per-user rows in ONE app.
//   purgeAccount — remove one user's per-user rows across EVERY app.
//
// 🔴 DELIBERATELY NOT BEHIND `enforceAppBlocksFlag`. The sibling
// `apps.mod.purgeSharedRow` is not either, for the same reason: a moderation
// takedown has to work when the feature kill-switch is dark. Flipping the
// consumer flag off during an incident is exactly the moment a moderator needs
// to remove what is stored, and a gate that refuses then would make the
// kill-switch and the takedown mutually exclusive.
//
// 🔴 NO MIN-TRUST / author gate. Per-user KV is the user's OWN self-scoped data.
// The min-trust gate on `apps.shared.*` exists because shared rows are readable
// by other users; that rationale does not transfer, and copying it here is the
// one way this surface gets it wrong. See the service header.
//
// Every purge writes an `AppListingModerationEvent` BEFORE it deletes anything —
// see `user-storage-purge.service.ts` for why that order is the safety argument.

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { moderatorProcedure, router } from '~/server/trpc';
import {
  AppUserStoragePurgeError,
  previewUserAppStorage,
  purgeUserAppStorage,
  purgeUserAppStorageEverywhere,
} from '~/server/services/apps/user-storage-purge.service';

const appBlockIdInput = z.string().min(1).max(64);
const targetUserIdInput = z.number().int().positive();

/**
 * A purge reason is REQUIRED and non-trivial, on both destructive verbs.
 *
 * The audit row's whole job is to say what was destroyed AND why; an optional
 * reason produces rows that answer only the first half, and the taxonomy this
 * rail already uses treats the rationale as required on every takedown verb
 * (`OFFSITE_MOD_REASON_MIN`/`MAX` on delist/relist/purge). Same floor and
 * ceiling here rather than a second, different pair of numbers.
 */
const purgeReasonInput = z.string().trim().min(3).max(1000);

export const appsModUserStorageRouter = router({
  /**
   * THE READ SURFACE — build and read this before running either verb below.
   *
   * Omit `appBlockId` for the account-wide view. The `apps[]` entries it returns
   * are the SAME objects a purge records as its `before` snapshot, so what a
   * moderator approved and what the audit log preserves cannot drift into two
   * different descriptions of one event.
   */
  preview: moderatorProcedure
    .input(
      z.object({
        userId: targetUserIdInput,
        appBlockId: appBlockIdInput.optional(),
      })
    )
    .query(async ({ input }) =>
      previewUserAppStorage({ userId: input.userId, appBlockId: input.appBlockId ?? null })
    ),

  /** TARGETED purge — one user's per-user rows in ONE app. */
  purgeApp: moderatorProcedure
    .input(
      z.object({
        userId: targetUserIdInput,
        appBlockId: appBlockIdInput,
        reason: purgeReasonInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await purgeUserAppStorage({
          actorUserId: ctx.user.id,
          targetUserId: input.userId,
          appBlockId: input.appBlockId,
          reason: input.reason,
        });
      } catch (err) {
        if (err instanceof AppUserStoragePurgeError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
        }
        throw err;
      }
    }),

  /**
   * ACCOUNT-WIDE purge — one user's per-user rows across EVERY app.
   *
   * Not one transaction, and it cannot be: the rows live in per-app schemas
   * reached through a pool the main db knows nothing about, and each app is
   * recorded as its own audit event. A failure on one app is collected into
   * `failures[]` and the sweep continues, so a single bad schema leaves a
   * complete record of which apps were purged and which were not, rather than
   * an unrecorded half-done sweep.
   */
  purgeAccount: moderatorProcedure
    .input(
      z.object({
        userId: targetUserIdInput,
        reason: purgeReasonInput,
      })
    )
    .mutation(async ({ ctx, input }) =>
      purgeUserAppStorageEverywhere({
        actorUserId: ctx.user.id,
        targetUserId: input.userId,
        reason: input.reason,
      })
    ),
});
