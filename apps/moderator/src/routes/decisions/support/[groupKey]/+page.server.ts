import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import {
  getSupportGroup,
  isGroupKey,
  listDuplicateTargets,
  isRouterVersion,
  listSupportTopics,
  supportVersion,
} from '$lib/server/decision-sources/support';
import {
  currentResolutions,
  recordResolution,
  resolutionStoreStatus,
} from '$lib/server/decision-resolution.service';
import {
  isGroupRuling,
  isMemberRuling,
  type GroupRuling,
  type MemberRuling,
  type ResolutionStoreStatus,
} from '$lib/decision-rulings';
import { groupSnapshot, memberSnapshot, parseGroupRuling, parseMemberLabel } from './ruling';

export const load: PageServerLoad = async ({ params, url, locals }) => {
  if (!isGroupKey(params.groupKey)) throw error(404, 'No such group.');
  const groupKey = params.groupKey;

  let version: string | null;
  let overridden: boolean;
  let detail: Awaited<ReturnType<typeof getSupportGroup>>;
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

  let storeStatus: ResolutionStoreStatus = 'ok';
  let resolutions: Awaited<ReturnType<typeof currentResolutions>> = [];
  try {
    resolutions = await currentResolutions({
      source: 'support-ticket',
      sourceVersion: version,
      itemKeys: [groupKey],
    });
  } catch (e) {
    console.error('[decisions] resolution store read failed', e);
    storeStatus = resolutionStoreStatus(e);
  }

  // The store returns the latest row per (item, sub-item); narrow each to the ruling kind its scope
  // admits. The DDL's scope CHECK makes a mismatch unrepresentable; the guards make it untyped-safe.
  let groupRuling: {
    ruling: GroupRuling;
    ruledBy: number;
    ruledAt: Date;
    targetKey: string | null;
  } | null = null;
  const memberLabels: Record<string, { ruling: MemberRuling; ruledBy: number; ruledAt: Date }> = {};
  for (const r of resolutions) {
    if (r.subKey === '' && isGroupRuling(r.ruling))
      groupRuling = {
        ruling: r.ruling,
        ruledBy: r.ruledBy,
        ruledAt: r.ruledAt,
        targetKey: r.targetKey,
      };
    else if (r.subKey !== '' && isMemberRuling(r.ruling))
      memberLabels[r.subKey] = { ruling: r.ruling, ruledBy: r.ruledBy, ruledAt: r.ruledAt };
  }

  return {
    version,
    overridden,
    detail,
    targets,
    topics: topics.map((t) => t.topic),
    groupRuling,
    memberLabels,
    storeStatus,
    // Both halves: the permission, and a store that can take the write. Controls are withheld rather
    // than shown-and-broken when either is missing.
    canRule: !!locals.grants['decisions.rule'] && storeStatus === 'ok',
  };
};

type RuleScope = 'rule' | 'label';

/**
 * Re-read the group the action rules on. `null` = gone from that version (404).
 *
 * 🔴 THE VERSION IS THE ONE THE PAGE SHOWED, posted with the form — never re-resolved. "Latest" can
 * move between the page loading and the click, and a ruling must be recorded against the version the
 * moderator was looking at. (`?/rule` replaces the page's query string, so `?version=` is not on the
 * action's URL either.)
 */
async function readGroup(groupKey: string, rawVersion: FormDataEntryValue | null) {
  if (!isRouterVersion(rawVersion)) return null;
  const version = rawVersion;
  const detail = await getSupportGroup({ version, groupKey });
  return detail ? { version, detail } : null;
}

/** A refused write, scoped to the panel that sent it. Never `throw error()`: that would unmount a
 *  page holding the moderator's half-written note. */
function writeFailure(scope: RuleScope, e: unknown, ticketId?: string) {
  console.error('[decisions] ruling failed', e);
  const message =
    e instanceof Error && e.message.includes('schema.sql')
      ? e.message
      : resolutionStoreStatus(e) === 'not-configured'
      ? 'MODERATOR_DATABASE_URL is not configured — the ruling was NOT recorded.'
      : 'The ruling was NOT recorded — the database refused the write.';
  return fail(503, { scope, error: message, ticketId });
}

/**
 * 🔴 BOTH ACTIONS ARE GATED ON `decisions.rule`, ON TOP OF THE PAGE GRANT. Opening the page is a
 * read; a ruling is labelled data, so who may produce it is a separate, deliberate grant.
 *
 * 🔴 NEITHER WRITES TO THE ROUTER. A ruling is appended to `decision_resolution`; `duplicate_of` and
 * `park` are recorded `apply_state = 'pending'` and the router remains the only writer to its catalog.
 */
export const actions: Actions = {
  rule: requiresGrant('decisions.rule', async ({ request, params, locals }) => {
    if (!isGroupKey(params.groupKey))
      return fail(404, { scope: 'rule' as const, error: 'No such group.' });
    const form = await request.formData();
    const parsed = parseGroupRuling(form, params.groupKey);
    if (typeof parsed === 'string') return fail(400, { scope: 'rule' as const, error: parsed });

    try {
      const current = await readGroup(params.groupKey, form.get('version'));
      if (!current)
        return fail(404, {
          scope: 'rule' as const,
          error: 'This group is not in the router version any more — reload the page.',
        });
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
        shown: groupSnapshot(current.detail),
      });
      // Zero rows written is not a recorded ruling.
      if (inserted === 0)
        return fail(503, { scope: 'rule' as const, error: 'The ruling was NOT recorded.' });
      return { scope: 'rule' as const, success: true, ruling: parsed.ruling };
    } catch (e) {
      return writeFailure('rule', e);
    }
  }),

  label: requiresGrant('decisions.rule', async ({ request, params, locals }) => {
    if (!isGroupKey(params.groupKey))
      return fail(404, { scope: 'label' as const, error: 'No such group.' });
    const form = await request.formData();
    const parsed = parseMemberLabel(form);
    if (typeof parsed === 'string') return fail(400, { scope: 'label' as const, error: parsed });

    try {
      const current = await readGroup(params.groupKey, form.get('version'));
      const shown = current ? memberSnapshot(current.detail, parsed.ticketId) : null;
      // The ticket must be a CURRENT member: the router may have re-routed it since the page loaded,
      // and a label recorded against a group it has left would be a label on the wrong pair.
      if (!current || !shown)
        return fail(404, {
          scope: 'label' as const,
          ticketId: parsed.ticketId,
          error: 'That ticket is no longer in this group — reload the page.',
        });
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
