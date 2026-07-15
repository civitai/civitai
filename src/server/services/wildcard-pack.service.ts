import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { getFileForModelVersion } from '~/server/services/file.service';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { allowMatureContentForCeiling } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { ModelType } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

/**
 * Session-authed resolve step for the App Blocks wildcard-pack import bridge
 * (W13). The page-host (PageBlockHost, running in the civitai page with the
 * viewer's REAL authenticated session) calls this on the block's behalf, then
 * fetches + unzips the returned signed URL CLIENT-SIDE, as the user. This proc
 * does the AUTHORITATIVE gating + URL resolution ONLY — it never fetches or
 * parses the zip (so a zip-bomb OOMs the user's browser tab, not a web pod).
 *
 * Why this is preferable to a block-JWT REST endpoint that server-side fetches +
 * unzips (the alternative in #3130):
 *   1. It resolves the file through `getFileForModelVersion` FOR THE CURRENT
 *      USER, so every creator/user download gate applies authoritatively —
 *      `requireAuth` (satisfied by the protectedProcedure session),
 *      `usageControl`/downloads-disabled, early-access/entitlement/
 *      `versionAccess.hasAccess`, published/public/archived/deleted — instead of
 *      a hand-rolled partial re-derivation that can bypass those gates.
 *   2. It returns only a short-lived signed URL; the bytes never touch a serving
 *      pod's heap.
 *
 * ALL download-gate refusals collapse to NOT_FOUND (no probing — a caller can't
 * distinguish "deleted" from "early-access" from "downloads-disabled" from
 * "doesn't exist"). The ONE distinct signal is the maturity gate: a pack whose
 * `nsfwLevel` exceeds the viewer's authoritative browsing-level ceiling is
 * FORBIDDEN (a mature pack is never served to an under-ceiling user).
 *
 * This does NOT count a download — a content read for a page block is the
 * lightest gated resolution, and `getFileForModelVersion` performs no
 * view/download increment.
 */

export interface ResolveWildcardPackResult {
  /** The gated, short-lived signed download URL (b2 `civitai-modelfiles`, which
   *  the delivery worker signs). The host fetches this cross-origin as the user. */
  signedUrl: string;
  /** Declared file size in bytes (for the host's pre-download cap). */
  sizeBytes: number;
  meta: {
    modelId: number;
    modelVersionId: number;
    modelName: string;
    versionName: string;
    creatorUsername: string | null;
  };
  maturity: {
    /** The viewer's authoritative browsing-level ceiling (flag bitmask). */
    browsingLevel: number;
    /** True when that ceiling permits no mature content. */
    sfwOnly: boolean;
  };
}

export async function resolveWildcardPackForUser({
  modelVersionId,
  user,
  canViewNsfw,
}: {
  modelVersionId: number;
  /** The real logged-in viewer (protectedProcedure guarantees this is set). */
  user: SessionUser;
  /** The per-request domain nsfw feature flag (green domain → false). */
  canViewNsfw: boolean;
}): Promise<ResolveWildcardPackResult> {
  // 1. Load the version for the type gate + maturity level + display meta. The
  //    `model: { is: {} }` filter drops orphaned-required-relation rows (same
  //    class as getFileForModelVersion) so a model-less version resolves to
  //    NOT_FOUND rather than throwing.
  const version = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId, model: { is: {} } },
    select: {
      id: true,
      name: true,
      nsfwLevel: true,
      model: {
        select: {
          id: true,
          type: true,
          name: true,
          user: { select: { username: true } },
        },
      },
    },
  });

  // Type gate: only `Wildcards`-type versions have importable list packs. A
  // missing version OR a non-Wildcards type collapses to NOT_FOUND (the type is
  // not itself sensitive, and a single code avoids leaking existence).
  if (!version || version.model.type !== ModelType.Wildcards) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Wildcard pack not found' });
  }

  // 2. AUTHORITATIVE download-gate + URL resolution for THIS user. Every refusal
  //    status (not-found / unauthorized / archived / downloads-disabled /
  //    early-access / resolve-failed / error) collapses to NOT_FOUND — no
  //    probing which gate refused. `requireAuth` is satisfied because a
  //    protectedProcedure always has a user id.
  const resolved = await getFileForModelVersion({ modelVersionId, user });
  if (resolved.status !== 'success') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Wildcard pack not found' });
  }

  // 3. Maturity ceiling — computed from the viewer's REAL session + domain, not
  //    a token claim. A pack whose nsfwLevel bit is not within the ceiling is
  //    FORBIDDEN. `hasFlag(ceiling, 0)` is true, so an unrated (0) pack passes.
  const browsingLevel = getServerBrowsingLevel({ canViewNsfw, user });
  const packLevel = version.nsfwLevel ?? 0;
  if (!Flags.hasFlag(browsingLevel, packLevel)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This wildcard pack exceeds your content maturity setting',
    });
  }

  // 4. Declared size for the host's pre-download cap. Read the sizeKB of the
  //    EXACT file the gate resolved (by its fileId) so the advertised size can't
  //    drift from the resolved URL.
  const file = await dbRead.modelFile.findUnique({
    where: { id: resolved.fileId },
    select: { sizeKB: true },
  });
  const sizeBytes = Math.max(0, Math.round((file?.sizeKB ?? 0) * 1024));

  return {
    signedUrl: resolved.url,
    sizeBytes,
    meta: {
      modelId: version.model.id,
      modelVersionId: version.id,
      modelName: version.model.name,
      versionName: version.name,
      creatorUsername: version.model.user?.username ?? null,
    },
    maturity: {
      browsingLevel,
      sfwOnly: allowMatureContentForCeiling(browsingLevel) === false,
    },
  };
}
