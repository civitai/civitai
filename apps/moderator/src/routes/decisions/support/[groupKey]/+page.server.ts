import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { denied } from '$lib/permissions';
import {
  getSupportGroup,
  groupMember,
  isGroupKey,
  isRouterVersion,
  listDuplicateTargets,
  listSupportTopics,
  supportVersion,
  type SupportGroupDetail,
} from '$lib/server/decision-sources/support';
import {
  currentResolutions,
  partitionResolutions,
  recordResolution,
  resolutionAnswer,
  type GroupRulingSummary,
  type MemberLabelSummary,
  type ResolutionAnswer,
} from '$lib/server/decision-resolution.service';
import { getPublicAgentReplies } from '$lib/server/freshdesk.service';
import { moderatorDbStatus, type ModeratorDbStatus } from '$lib/moderator-db-status';
import {
  groupSnapshot,
  memberSnapshot,
  parseGroupRuling,
  parseMemberLabel,
  snapshotChanged,
  snapshotFingerprint,
} from './ruling';

export const load: PageServerLoad = async ({ params, url, locals }) => {
  if (!isGroupKey(params.groupKey)) throw error(404, 'No such group.');
  const groupKey = params.groupKey;

  let version: string | null;
  let overridden: boolean;
  let detail: SupportGroupDetail | null;
  let targets: Awaited<ReturnType<typeof listDuplicateTargets>> = [];
  let topics: Awaited<ReturnType<typeof listSupportTopics>> = [];
  try {
    ({ version, overridden } = await supportVersion(url.searchParams.get('version')));
    if (!version) throw error(404, 'The support-ticket router has not written any groups yet.');
    detail = await getSupportGroup({ version, groupKey });
    if (detail)
      [targets, topics] = await Promise.all([
        listDuplicateTargets({ version, groupKey, topic: detail.group.topic }),
        listSupportTopics(version),
      ]);
  } catch (e) {
    if (typeof (e as { status?: unknown }).status === 'number') throw e;
    console.error('[decisions] support group load failed', e);
    throw error(503, "Could not read the support-ticket router's data.");
  }
  // Zero rows is "this version has no such group" — a 404, never an empty group.
  if (!detail) throw error(404, `No group ${groupKey} in router version ${version}.`);

  let storeStatus: ModeratorDbStatus = 'ok';
  let groupRuling: GroupRulingSummary | null = null;
  let memberLabels: Record<string, MemberLabelSummary> = {};
  let answer: ResolutionAnswer | null = null;
  try {
    const { groups, members } = partitionResolutions(
      await currentResolutions({
        source: 'support-ticket',
        sourceVersion: version,
        itemKeys: [groupKey],
      })
    );
    groupRuling = groups.get(groupKey) ?? null;
    memberLabels = members.get(groupKey) ?? {};
    if (groupRuling?.ruling === 'resolved') answer = await resolutionAnswer(groupRuling.id);
  } catch (e) {
    console.error('[decisions] resolution store read failed', e);
    storeStatus = moderatorDbStatus(e);
  }

  return {
    version,
    overridden,
    detail,
    targets,
    topics: topics.map((t) => t.topic),
    groupRuling,
    answer,
    memberLabels,
    // Posted back with a group ruling, so a group that moved underneath the page is refused.
    fingerprint: snapshotFingerprint(detail),
    storeStatus,
    // Both halves: the permission, and a store that can take the write. Controls are withheld rather
    // than shown-and-broken when either is missing.
    canRule: !!locals.grants['decisions.rule'] && storeStatus === 'ok',
    // `resolved` needs both permissions; the action checks the same pair.
    canAnswer:
      !!locals.grants['decisions.rule'] &&
      !!locals.grants['decisions.answer'] &&
      storeStatus === 'ok',
  };
};

type Scope = 'rule' | 'label';

/**
 * Re-read the group the action rules on: `{ ok: true, … }`, or the `fail()` to return.
 *
 * 🔴 THE VERSION IS THE ONE THE PAGE SHOWED, posted with the form — never re-resolved. "Latest" can
 * move between the page loading and the click, and a ruling must be recorded against the version the
 * moderator was looking at. (`?/rule` replaces the page's query string, so `?version=` is not on the
 * action's URL either.)
 *
 * Its own failure path, separate from the write's: a router-data outage reported as "the database
 * refused the write" sends the operator to the wrong store.
 */
async function reread(scope: Scope, groupKey: string, rawVersion: FormDataEntryValue | null) {
  const gone = (ticketId?: string) =>
    fail(404, {
      scope,
      ticketId,
      error: 'This group is not in that router version any more — reload the page.',
    });
  if (!isRouterVersion(rawVersion)) return { ok: false as const, failure: gone() };
  try {
    const detail = await getSupportGroup({ version: rawVersion, groupKey });
    return detail
      ? { ok: true as const, version: rawVersion, detail }
      : { ok: false as const, failure: gone() };
  } catch (e) {
    console.error('[decisions] router re-read failed', e);
    return {
      ok: false as const,
      failure: fail(503, {
        scope,
        error: "Could not re-read the router's data — the ruling was NOT recorded.",
      }),
    };
  }
}

/**
 * Confirm the reply a `resolved` answer cites: a public agent reply, on a ticket that is a CURRENT
 * member of the group. `null` when it holds, else the `fail()` to return.
 *
 * 🔴 RE-ASKED HERE, NEVER TAKEN FROM THE FORM. The ids are posted by the page, so without this check
 * the stored provenance would be whatever the client sent. Freshdesk being unreachable refuses the
 * ruling rather than storing an unconfirmed source; removing the source records the answer alone.
 */
async function confirmAnswerSource(
  source: NonNullable<ResolutionAnswer['source']>,
  detail: SupportGroupDetail
) {
  if (!groupMember(detail, source.ticketId))
    return fail(400, {
      scope: 'rule' as const,
      error: `Ticket #${source.ticketId} is no longer in this group — remove the source or pick another reply.`,
    });
  const replies = await getPublicAgentReplies(source.ticketId);
  if (replies.status === 'unavailable')
    return fail(503, {
      scope: 'rule' as const,
      error: `Could not confirm the source reply (${replies.reason}) — the ruling was NOT recorded. Remove the source to record the answer without it.`,
    });
  if (
    replies.status === 'none' ||
    !replies.replies.some((r) => r.conversationId === source.conversationId)
  )
    return fail(400, {
      scope: 'rule' as const,
      error: `That reply is not a public agent reply on ticket #${source.ticketId} — remove the source or pick another.`,
    });
  return null;
}

/** A refused write. Never `throw error()`: that would unmount a page holding a half-written note. */
function writeFailure(scope: Scope, e: unknown, ticketId?: string) {
  console.error('[decisions] ruling write failed', e);
  // Only this module's own messages reach the operator — never a raw driver error.
  const message =
    e instanceof Error && e.message.includes('decisions/schema.sql')
      ? e.message
      : moderatorDbStatus(e) === 'not-configured'
      ? 'MODERATOR_DATABASE_URL is not configured — the ruling was NOT recorded.'
      : 'The ruling was NOT recorded — the database refused the write.';
  return fail(503, { scope, error: message, ticketId });
}

/**
 * 🔴 BOTH ACTIONS ARE GATED ON `decisions.rule`, ON TOP OF THE PAGE GRANT. Opening the page is a
 * read; a ruling is labelled data, so who may produce it is a separate, deliberate grant. A `resolved`
 * ruling also needs `decisions.answer` — its answer is text meant for customers.
 *
 * 🔴 NEITHER WRITES TO THE ROUTER. A ruling is appended to `decision_resolution`; `duplicate_of` and
 * `park` are recorded `apply_state = 'pending'` and the router remains the only writer to its catalog.
 *
 * 0 rows WRITTEN is a 503, not the `/abuse` 404: this is an INSERT, so the missing-target case is
 * the re-read's 404, and an insert that wrote nothing is a failed write.
 */
export const actions: Actions = {
  rule: requiresGrant('decisions.rule', async ({ request, params, locals }) => {
    if (!isGroupKey(params.groupKey))
      return fail(404, { scope: 'rule' as const, error: 'No such group.' });
    const form = await request.formData();
    // Before parsing, so a refusal never depends on what else the form held.
    if (form.get('ruling') === 'resolved' && !locals.grants['decisions.answer'])
      return fail(403, { scope: 'denied' as const, error: denied('decisions.answer') });
    const parsed = parseGroupRuling(form, params.groupKey);
    if (typeof parsed === 'string') return fail(400, { scope: 'rule' as const, error: parsed });

    const current = await reread('rule', params.groupKey, form.get('version'));
    if (!current.ok) return current.failure;
    if (snapshotChanged(form.get('fingerprint'), current.detail))
      return fail(409, {
        scope: 'rule' as const,
        error:
          'The group changed since this page loaded, so this was NOT recorded. The page is being ' +
          'refreshed — review the group again before you resubmit.',
      });

    try {
      if (parsed.targetKey !== null) {
        const target = await getSupportGroup({
          version: current.version,
          groupKey: parsed.targetKey,
        });
        if (!target)
          return fail(400, {
            scope: 'rule' as const,
            error: 'The group chosen as the original does not exist in this version.',
          });
      }
      if (parsed.escalateTo !== null) {
        const topics = await listSupportTopics(current.version);
        if (!topics.some((t) => t.topic === parsed.escalateTo))
          return fail(400, { scope: 'rule' as const, error: 'Unknown escalation area.' });
      }
    } catch (e) {
      console.error('[decisions] router re-read failed', e);
      return fail(503, {
        scope: 'rule' as const,
        error: "Could not re-read the router's data — the ruling was NOT recorded.",
      });
    }

    const answerSource = parsed.answer?.source ?? null;
    if (answerSource) {
      const refused = await confirmAnswerSource(answerSource, current.detail);
      if (refused) return refused;
    }

    try {
      const { inserted } = await recordResolution({
        source: 'support-ticket',
        itemKey: params.groupKey,
        subKey: '',
        sourceVersion: current.version,
        area: current.detail.group.topic || null,
        ruling: parsed.ruling,
        targetKey: parsed.targetKey,
        escalateTo: parsed.escalateTo,
        note: parsed.note,
        // The user ID, never the username — a username can be reassigned.
        ruledBy: locals.user.id,
        // Ids only — the reply's text is customer correspondence and is never stored.
        shown: answerSource
          ? {
              ...groupSnapshot(current.detail),
              answer_source: {
                ticket_id: answerSource.ticketId,
                conversation_id: answerSource.conversationId,
              },
            }
          : groupSnapshot(current.detail),
        answer: parsed.answer,
      });
      if (inserted === 0)
        return fail(503, { scope: 'rule' as const, error: 'The ruling was NOT recorded.' });
      return { scope: 'rule' as const, success: true, ruling: parsed.ruling };
    } catch (e) {
      return writeFailure('rule', e);
    }
  }),

  label: requiresGrant('decisions.rule', async ({ request, params, locals }) => {
    const form = await request.formData();
    // Echoed on every refusal so the page can render it on the row that was clicked.
    const rawTicket = form.get('ticketId');
    const ticketId = typeof rawTicket === 'string' ? rawTicket : undefined;
    if (!isGroupKey(params.groupKey))
      return fail(404, { scope: 'label' as const, ticketId, error: 'No such group.' });
    const parsed = parseMemberLabel(form);
    if (typeof parsed === 'string')
      return fail(400, { scope: 'label' as const, ticketId, error: parsed });

    const current = await reread('label', params.groupKey, form.get('version'));
    if (!current.ok) return current.failure;
    // The ticket must be a CURRENT member: the router may have re-routed it since the page loaded,
    // and a label recorded against a group it has left would be a label on the wrong pair.
    const shown = memberSnapshot(current.detail, parsed.ticketId);
    if (!shown)
      return fail(404, {
        scope: 'label' as const,
        ticketId: parsed.ticketId,
        error: 'That ticket is no longer in this group — reload the page.',
      });
    // The founder belongs by construction; whether founding was right is the group ruling.
    if (shown.is_founder)
      return fail(400, {
        scope: 'label' as const,
        ticketId: parsed.ticketId,
        error: 'The founding ticket is not labelled — rule on the group instead.',
      });

    try {
      const { inserted } = await recordResolution({
        source: 'support-ticket',
        itemKey: params.groupKey,
        subKey: parsed.ticketId,
        sourceVersion: current.version,
        area: current.detail.group.topic || null,
        ruling: parsed.ruling,
        targetKey: null,
        escalateTo: null,
        note: null,
        ruledBy: locals.user.id,
        shown,
      });
      if (inserted === 0)
        return fail(503, {
          scope: 'label' as const,
          ticketId: parsed.ticketId,
          error: 'The label was NOT recorded.',
        });
      return {
        scope: 'label' as const,
        success: true,
        ticketId: parsed.ticketId,
        ruling: parsed.ruling,
      };
    } catch (e) {
      return writeFailure('label', e, parsed.ticketId);
    }
  }),
};
