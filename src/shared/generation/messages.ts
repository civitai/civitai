/**
 * Generator messages — mod-authored copy shown above the submit row. NOT a gate:
 * a message blocks nothing, and an untargeted one is generator-wide (an
 * untargeted gate would just be a broken rule).
 *
 * Stored under its own Redis field, so a build that predates this file ignores
 * it — a new value inside the gate-rules array would fail that build's parser.
 */

import { z } from 'zod';

/**
 * WHO sees the message. Multi-select, evaluated as a union; an empty list means
 * everyone. `members` / `nonMembers` are the coarse split, the tiers are for
 * when copy only applies to one of them (a price change to gold, say).
 */
export const messageAudienceSchema = z.enum([
  'members',
  'nonMembers',
  'free',
  'founder',
  'bronze',
  'silver',
  'gold',
]);
export type MessageAudience = z.infer<typeof messageAudienceSchema>;

/**
 * WHAT kind of message. Drives the icon, the tone, and the DEFAULT for
 * `dismissible` — each kind has to earn its place by changing behaviour, or the
 * list grows a new entry every time someone wants different wording.
 */
export const messageKindSchema = z.enum(['pricing', 'maintenance', 'info']);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const generatorMessageSchema = z.object({
  id: z.string(),
  /** Mod-facing name, e.g. "MiniMax H3 price change". */
  name: z.string().default(''),
  kind: messageKindSchema,
  /** The copy itself. A message without one has nothing to say and is dropped. */
  message: z.string(),
  dismissible: z.boolean(),
  /** Empty = every user. */
  audiences: z.array(messageAudienceSchema).default([]),
  // Empty across all three = every generation, not "no generations".
  ecosystems: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  modelVersionIds: z.array(z.number().int().positive()).default([]),
});
export type GeneratorMessage = z.infer<typeof generatorMessageSchema>;

export type MessageUserCtx = { isMember: boolean; tier: string };

export type MessageSelection = {
  ecosystem?: string;
  workflow?: string;
  versionIds?: number[];
};

/** Whether a message's audience includes this user. */
export function messageAppliesToUser(message: GeneratorMessage, user: MessageUserCtx): boolean {
  if (!message.audiences.length) return true;
  return message.audiences.some((audience) =>
    audience === 'members'
      ? user.isMember
      : audience === 'nonMembers'
      ? !user.isMember
      : audience === user.tier
  );
}

/**
 * SERVER: narrow stored messages to the ones this user should receive. The
 * audience filter runs here rather than on the client so mod-authored copy for
 * one tier never ships in another tier's payload.
 */
export function applicableMessagesFor(
  messages: GeneratorMessage[],
  user: MessageUserCtx
): GeneratorMessage[] {
  return messages.filter(
    (message) => !!message.message.trim() && messageAppliesToUser(message, user)
  );
}

/** Whether a message's targets match the current selection. */
export function messageMatchesSelection(
  message: GeneratorMessage,
  selection: MessageSelection
): boolean {
  const { ecosystems, workflows, modelVersionIds } = message;
  if (!ecosystems.length && !workflows.length && !modelVersionIds.length) return true;
  if (selection.ecosystem && ecosystems.includes(selection.ecosystem)) return true;
  if (selection.workflow && workflows.includes(selection.workflow)) return true;
  return (selection.versionIds ?? []).some((id) => modelVersionIds.includes(id));
}

/** Matches, in the moderator's authored order — deliberately not severity-sorted. */
export function messagesForSelection(
  messages: GeneratorMessage[],
  selection: MessageSelection
): GeneratorMessage[] {
  return messages.filter((message) => messageMatchesSelection(message, selection));
}

/**
 * djb2 → base36. Only ever compared against itself, so a collision costs one
 * missed re-notify rather than correctness.
 */
function fingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * Dismissal key, fingerprinted on the copy so an edited message re-notifies
 * everyone who dismissed the old wording.
 */
export function messageDismissId(message: GeneratorMessage): string {
  return `${message.id}#${fingerprint(message.message)}`;
}
