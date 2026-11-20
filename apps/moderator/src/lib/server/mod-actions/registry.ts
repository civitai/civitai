import type { z } from 'zod';
import { env } from '$env/dynamic/private';
import {
  MOD_ACTION,
  abuseReportInput,
  caseDefinitionsInput,
  caseIntakeInput,
  feedbackTriageInput,
  imageModerateInput,
  relabelBuildBatchInput,
} from '@civitai/moderation';
import { hqTaskFromUrl } from '@civitai/shared/clickup-url';
import {
  acceptImage,
  blockImage,
  ImageNotFoundError,
  ImageNotRestoredError,
} from '../image-moderation.service';
import { CSAM_BLOCKLIST_RETRY, CsamBlocklistWriteError } from '../image-moderation-effects';
import { recordAbuseRun } from '../abuse-detection.service';
import { logToAxiom } from '../axiom';
import { getClickhouse } from '../clickhouse';
import { caseIntake, defaultCaseIntakeDeps } from '../cases/case-intake-action';
import { enabledDefinitions, publicDefinition } from '../cases/definitions';
import { civitaiAppUrl } from '../civitai-url';
import { dbRead, dbWrite } from '../db';
import { triageFeedback } from '../feedback.service';
import { getModeratorDb } from '../moderator-db';
import { relabelBuildBatchAction } from '../relabel-batch-build';
import { heldRemovalMessage, type HeldRemoval } from '../removal-hold';
import { SYSTEM_USER_ID } from '../users.service';

// The cross-app moderator-action registry. Each entry maps an action the main app invokes over
// `/api/mod/[action]` to a spoke handler. The input SCHEMA is the shared `@civitai/moderation` contract
// (so the endpoint validates the exact shape the main-app client sends); the HANDLER calls the same spoke
// services the moderator pages use, so both entry points run identical code. Where an action has an acting
// moderator, `userId` is that moderator, asserted by the trusted caller (the main app already gated the
// action behind `moderatorProcedure`). Scheduled callers have none.
//
// This is the ONE sanctioned inbound seam. Add an action here + its schema/method in @civitai/moderation;
// don't add ad-hoc endpoints.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModAction<T = any> = {
  schema: z.ZodType<T>;
  handler: (input: T) => Promise<unknown>;
};

const listIds = (ids: number[]) => ids.join(', ');

const notRestoredMessage = (notRestored: number[], notFound: number[], restored: number[]) =>
  [
    notRestored.length > 1
      ? `Images ${listIds(
          notRestored
        )} were not restored: each can only be restored through its own review.`
      : notRestored.length
      ? `Image ${notRestored[0]} was not restored: it can only be restored through its own review.`
      : '',
    notFound.length > 1
      ? `Images ${listIds(notFound)} were not found.`
      : notFound.length
      ? `Image ${notFound[0]} was not found.`
      : '',
    restored.length > 1
      ? `Images ${listIds(restored)} were restored.`
      : restored.length
      ? `Image ${restored[0]} was restored.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

// Backs the main app's `image.moderate` (block/unblock over one or more ids). Single-image verdicts loop
// the spoke services; the moderator UI always sends one id, but the batch shape is preserved.
const imageModerate: ModAction<z.infer<typeof imageModerateInput>> = {
  schema: imageModerateInput,
  handler: async ({ ids, reviewAction, userId, ip, userAgent, canConfirmReRemoval }) => {
    const held: HeldRemoval[] = [];
    const notRestored: number[] = [];
    const notFound: number[] = [];
    const csamBlocklistFailed: number[] = [];
    const restored: number[] = [];
    for (const imageId of ids) {
      // Delegated accept uses the smart default (removeMinorFlag is a spoke-only, minor-page option).
      if (reviewAction === 'unblock')
        await acceptImage({ imageId, userId, restoreRemoved: true }).then(
          () => restored.push(imageId),
          (e) => {
            if (e instanceof ImageNotRestoredError) notRestored.push(imageId);
            else if (e instanceof ImageNotFoundError) notFound.push(imageId);
            else throw e;
          }
        );
      else {
        const result = await blockImage({
          imageId,
          userId,
          ip,
          userAgent,
          source: 'site.imageModerate',
          skipAppealCheck: canConfirmReRemoval,
        }).catch((e: unknown): Awaited<ReturnType<typeof blockImage>> => {
          if (!(e instanceof CsamBlocklistWriteError)) throw e;
          csamBlocklistFailed.push(imageId);
          return {};
        });
        if (result.held) held.push(result.held);
      }
    }
    // The blocks committed; the moderator is told to retry the CSAM blocklist entry.
    if (csamBlocklistFailed.length)
      throw Object.assign(new Error(CSAM_BLOCKLIST_RETRY), { status: 502 });
    // A 409 so the main app shows the moderator why the image is still up.
    if (held.length) throw Object.assign(new Error(heldRemovalMessage(held)), { status: 409 });
    if (notRestored.length || notFound.length)
      throw Object.assign(new Error(notRestoredMessage(notRestored, notFound, restored)), {
        status: 409,
      });
    return { count: ids.length };
  },
};

/**
 * Backs an automated detector reporting one run. Like `relabelBuildBatch`, there is NO acting
 * moderator: the caller is a scheduled job holding the shared token, and `WebhookEndpoint` never
 * populates `locals.user`, so there is no identity to assert and none is asked for. The `userId` on
 * each finding is the account the finding is ABOUT.
 *
 * Write-only from the producer's side — this stores the report and grants nothing. Nothing here
 * excludes, mutes or bans; acting stays with the detector that already owns that credential, which
 * is what keeps a compromised reporting path from becoming a moderation path.
 */
const abuseReport: ModAction<z.infer<typeof abuseReportInput>> = {
  schema: abuseReportInput,
  handler: async (input) => {
    const { runId } = await recordAbuseRun(input);
    return { runId, findings: input.findings.length };
  },
};

/**
 * Backs the main app's daily `relabel-build-batch` job. A scheduled caller again, with no acting
 * moderator. Writes only to `relabel_item`, and only when `dryRun` is false.
 *
 * The not-removed stratum's score bands come from `RELABEL_NOT_REMOVED_BANDS`, never from the
 * caller or the repo. Unset or malformed, the batch holds removed items only.
 */
const relabelBuildBatch: ModAction<z.infer<typeof relabelBuildBatchInput>> = {
  schema: relabelBuildBatchInput,
  handler: (input) =>
    relabelBuildBatchAction(
      input,
      env.RELABEL_NOT_REMOVED_BANDS,
      {
        clickhouse: (query) => getClickhouse().$query(query),
        replica: dbRead,
        moderator: getModeratorDb(),
      },
      (data) => void logToAxiom(data)
    ),
};

/**
 * Backs the main app's `/api/mod/feedback/triage` (a moderator's API key) and its HQ status sync.
 * The SAME `triageFeedback` the queue's status buttons call, so the compare-and-set on
 * `expectedStatus`, the handler/time stamps, the change-feed stamp and the audit row are one
 * implementation. `userId` is the acting moderator, asserted by the main app after its
 * `feedback.status.set` check.
 */
const feedbackTriage: ModAction<z.infer<typeof feedbackTriageInput>> = {
  schema: feedbackTriageInput,
  handler: ({ id, status, expectedStatus, expectedHandledById, noteAppend, hqTaskUrl, userId }) =>
    triageFeedback({
      id,
      status,
      expectedStatus,
      expectedHandledById,
      noteAppend,
      // The schema already refused anything else; null cannot reach here.
      hqTask: hqTaskUrl ? hqTaskFromUrl(hqTaskUrl) ?? undefined : undefined,
      moderatorId: userId,
    }),
};

/** The open takedown forms, as the public pages draw them: fields only, nothing moderator-side. */
const caseDefinitions: ModAction<z.infer<typeof caseDefinitionsInput>> = {
  schema: caseDefinitionsInput,
  handler: async () => ({
    definitions: (await enabledDefinitions()).map((d) => publicDefinition(d.definition)),
  }),
};

/**
 * A public takedown request from the main app's form. No acting user: the caller holds only the
 * scoped intake credential, and `submitterUserId` is recorded, never trusted for access.
 */
const caseIntakeAction: ModAction<z.infer<typeof caseIntakeInput>> = {
  schema: caseIntakeInput,
  handler: (input) =>
    caseIntake(
      input,
      defaultCaseIntakeDeps({
        mainDb: dbWrite,
        appUrl: civitaiAppUrl(),
        systemUserId: SYSTEM_USER_ID,
        log: (data) => void logToAxiom(data),
      })
    ),
};

export const modActions: Record<string, ModAction> = {
  [MOD_ACTION.imageModerate]: imageModerate,
  [MOD_ACTION.abuseReport]: abuseReport,
  [MOD_ACTION.relabelBuildBatch]: relabelBuildBatch,
  [MOD_ACTION.feedbackTriage]: feedbackTriage,
  [MOD_ACTION.caseDefinitions]: caseDefinitions,
  [MOD_ACTION.caseIntake]: caseIntakeAction,
};
