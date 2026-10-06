import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  isGroupRuling,
  isMemberRuling,
  type GroupRuling,
  type MemberRuling,
} from '$lib/decision-rulings';
import {
  isAreaSlug,
  isTicketId,
  type SupportGroupDetail,
} from '$lib/server/decision-sources/support';
import { parseForm } from '$lib/server/query';

/**
 * What the moderator was shown when they ruled — stored with the ruling so the label stays tied to
 * its evidence after the router moves the group on.
 *
 * 🔴 BUILT FROM A SERVER RE-READ AT RULING TIME, NEVER FROM THE FORM. A posted snapshot would be
 * whatever the client chose to send. Probabilities that were never measured stay `null` here exactly
 * as on screen — a stored 0 would turn "no model call" back into a confident answer in the training
 * data, which is the one place the difference matters most.
 */
export function groupSnapshot(d: SupportGroupDetail): Record<string, unknown> {
  const members = d.decision?.members ?? [];
  return {
    topic: d.group.topic,
    created_by: d.group.createdBy,
    founded_ticket_id: d.group.foundedTicketId,
    founder_position: d.founder,
    n_members: members.length,
    topics_spanned: d.topicsSpanned,
    question_spec_hashes: d.specHashes,
    members: members.map((m) => ({
      ticket_id: m.ticketId,
      chosen_topic: m.chosenTopic,
      p_topic: m.probabilities.topic,
      p_group: m.probabilities.group,
      p_novel: m.probabilities.novel,
    })),
  };
}

/** The snapshot for a per-member label, or `null` when the ticket is not a current member. */
export function memberSnapshot(
  d: SupportGroupDetail,
  ticketId: string
): Record<string, unknown> | null {
  const m = d.decision?.members.find((x) => x.ticketId === ticketId);
  if (!m) return null;
  return {
    ticket_id: m.ticketId,
    chosen_topic: m.chosenTopic,
    p_topic: m.probabilities.topic,
    p_group: m.probabilities.group,
    p_novel: m.probabilities.novel,
    is_founder: m.isFounder,
    question_spec_hash: m.questionSpecHash,
    group_created_by: d.group.createdBy,
    n_members: d.decision?.members.length ?? 0,
  };
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const groupRulingSchema = z.object({
  ruling: z.string().refine(isGroupRuling, 'Choose a ruling.'),
  targetKey: optionalText(64),
  escalateTo: optionalText(64),
  note: optionalText(2000),
});

export type ParsedGroupRuling = {
  ruling: GroupRuling;
  targetKey: string | null;
  escalateTo: string | null;
  note: string | null;
};

/**
 * A group ruling from the form, or the message to refuse it with.
 *
 * Each field is kept only where its ruling uses it, so a target left in a hidden input cannot ride
 * along on a `correct`. The DDL enforces the same pairing; this is what lets the refusal be specific.
 */
export function parseGroupRuling(form: FormData, selfKey: string): ParsedGroupRuling | string {
  const parsed = parseForm(groupRulingSchema, form);
  if (typeof parsed === 'string') return parsed;
  const r = parsed.ruling as GroupRuling;
  const targetKey = r === 'duplicate_of' ? parsed.targetKey : null;
  const escalateTo = r === 'escalate' ? parsed.escalateTo : null;
  if (r === 'duplicate_of' && !targetKey) return 'Choose the group this one duplicates.';
  if (r === 'duplicate_of' && targetKey === selfKey) return 'A group cannot duplicate itself.';
  if (r === 'escalate' && !escalateTo) return 'Choose who to escalate to.';
  // Areas are the source's topic slugs until an area taxonomy exists. Membership in the version's
  // topic set is checked by the action, which has the source to ask.
  if (escalateTo !== null && !isAreaSlug(escalateTo)) return 'Unknown escalation area.';
  return { ruling: r, targetKey, escalateTo, note: parsed.note };
}

const memberLabelSchema = z.object({
  ticketId: z.string().refine(isTicketId, 'Missing ticket id.'),
  ruling: z.string().refine(isMemberRuling, 'Choose belongs, does not belong or unsure.'),
});

export function parseMemberLabel(
  form: FormData
): { ticketId: string; ruling: MemberRuling } | string {
  const parsed = parseForm(memberLabelSchema, form);
  if (typeof parsed === 'string') return parsed;
  return { ticketId: parsed.ticketId, ruling: parsed.ruling as MemberRuling };
}

/**
 * A fingerprint of everything `groupSnapshot` stores — membership, each member's topic and
 * probabilities, the group's own topic.
 */
export const snapshotFingerprint = (d: SupportGroupDetail): string =>
  createHash('sha256')
    .update(JSON.stringify(groupSnapshot(d)))
    .digest('hex')
    .slice(0, 32);

/**
 * Has the group changed since the moderator's page loaded?
 *
 * 🔴 THE SNAPSHOT IS ONLY "WHAT THE HUMAN SAW" IF NOTHING MOVED IN BETWEEN. It is built from a server
 * re-read (so the client cannot forge it), and the router keeps adding and re-routing members while a
 * page sits open — including re-routing a ticket into the SAME group with new probabilities, which a
 * member-id comparison would miss. The page posts the fingerprint of the snapshot it rendered; any
 * difference refuses the ruling rather than storing evidence the moderator never looked at. Nothing
 * posted is a difference too.
 */
export const snapshotChanged = (
  posted: FormDataEntryValue | null,
  d: SupportGroupDetail
): boolean => posted !== snapshotFingerprint(d);
