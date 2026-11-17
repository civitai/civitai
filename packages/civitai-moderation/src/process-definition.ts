import { z } from 'zod';

/**
 * A process definition is the data behind one intake process (a DMCA notice, a counter-notice, ...): the form
 * it asks for, the states a case moves through, its clocks and the notices it sends. Definitions are stored as
 * versioned rows and a case pins the version it started on.
 *
 * What a definition may not do is enforced here, not left to whoever writes the row:
 * - effects come from a fixed set (`EFFECT_KINDS`); an unknown one fails to parse;
 * - removing or restoring content, and sending notices, happen only on transitions a moderator presses. A
 *   public action (what a claimant or uploader can do from their case page) has no effects at all: it records an
 *   event, takes its fields and may only move the case into a state marked `needsReview`;
 * - a notice body may only use the named slots in `NOTICE_SLOTS`.
 */

export const FIELD_KINDS = [
  'text',
  'textarea',
  'email',
  'url',
  'urlList',
  'checkbox',
  'signature',
  'select',
] as const;

export const PARTY_ROLES = ['claimant', 'uploader', 'agent-for-uploader'] as const;

export const NOTICE_SLOTS = ['caseRef', 'items', 'continueLink', 'receivedAt'] as const;

const id = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'ids are lowercase slugs, at most 40 characters');

const fieldSchema = z.strictObject({
  id,
  label: z.string().min(1),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().default(false),
  help: z.string().optional(),
  options: z
    .array(z.strictObject({ value: z.string().min(1), label: z.string().min(1) }))
    .optional(),
});

const effectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('removeTargets') }),
  z.strictObject({ kind: z.literal('restoreTargets') }),
  z.strictObject({ kind: z.literal('removeDerivedImages') }),
  z.strictObject({ kind: z.literal('sendNotice'), notice: id }),
  z.strictObject({ kind: z.literal('startClock'), clock: id }),
  z.strictObject({ kind: z.literal('stopClock'), clock: id }),
  z.strictObject({ kind: z.literal('escalateToLegal') }),
]);
export const EFFECT_KINDS = effectSchema.options.map((o) => o.shape.kind.value);

const noticeBodySchema = z.strictObject({ subject: z.string().min(1), body: z.string().min(1) });

const definitionShape = z.strictObject({
  key: id,
  title: z.string().min(1),
  /** The Reply-To of every notice this process sends. */
  mailbox: z.email(),
  fields: z.array(fieldSchema).min(1),
  checklist: z.array(z.strictObject({ id, label: z.string().min(1) })).default([]),
  states: z
    .array(
      z.strictObject({
        id,
        label: z.string().min(1),
        terminal: z.boolean().default(false),
        /** A public action may move a case only into a state with this set. */
        needsReview: z.boolean().default(false),
      })
    )
    .min(1),
  initialState: id,
  transitions: z
    .array(
      z.strictObject({
        id,
        from: id,
        to: id,
        label: z.string().min(1),
        requires: z.array(id).default([]),
        effects: z.array(effectSchema).default([]),
      })
    )
    .default([]),
  clocks: z
    .array(
      z
        .strictObject({
          id,
          label: z.string().min(1),
          hours: z.number().int().positive().optional(),
          businessDays: z.number().int().positive().optional(),
          warnBeforeHours: z.number().int().positive().optional(),
        })
        .refine((c) => (c.hours === undefined) !== (c.businessDays === undefined), {
          message: 'a clock runs for either hours or businessDays',
        })
    )
    .default([]),
  notices: z
    .array(
      noticeBodySchema.extend({
        id,
        recipientRole: z.enum(PARTY_ROLES),
        /** Alternative wording keyed by a target's readback state, e.g. `Restored`. */
        variants: z.record(z.string().min(1), noticeBodySchema).optional(),
      })
    )
    .default([]),
  publicActions: z
    .array(
      z.strictObject({
        id,
        role: z.enum(PARTY_ROLES),
        label: z.string().min(1),
        fields: z.array(id).default([]),
        /** The case event this action records. */
        records: id,
        moveTo: id.optional(),
      })
    )
    .default([]),
});

const SLOT = /\{([^{}]*)\}/g;

export const processDefinitionSchema = definitionShape.superRefine((d, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  for (const key of [
    'fields',
    'checklist',
    'states',
    'transitions',
    'clocks',
    'notices',
    'publicActions',
  ] as const) {
    const seen = new Set<string>();
    d[key].forEach((item, i) => {
      if (seen.has(item.id)) issue([key, i, 'id'], `duplicate id "${item.id}"`);
      seen.add(item.id);
    });
  }

  const states = new Map(d.states.map((s) => [s.id, s]));
  const fieldIds = new Set(d.fields.map((f) => f.id));
  const checklistIds = new Set(d.checklist.map((c) => c.id));
  const clockIds = new Set(d.clocks.map((c) => c.id));
  const noticeIds = new Set(d.notices.map((n) => n.id));

  if (!states.has(d.initialState)) issue(['initialState'], `unknown state "${d.initialState}"`);

  d.fields.forEach((f, i) => {
    if (f.kind === 'select' && !f.options?.length)
      issue(['fields', i, 'options'], 'a select needs options');
  });

  d.transitions.forEach((t, i) => {
    if (!states.has(t.from)) issue(['transitions', i, 'from'], `unknown state "${t.from}"`);
    if (!states.has(t.to)) issue(['transitions', i, 'to'], `unknown state "${t.to}"`);
    if (states.get(t.from)?.terminal) issue(['transitions', i, 'from'], `"${t.from}" is terminal`);
    t.requires.forEach((r, j) => {
      if (!checklistIds.has(r))
        issue(['transitions', i, 'requires', j], `unknown checklist item "${r}"`);
    });
    t.effects.forEach((e, j) => {
      if (e.kind === 'sendNotice' && !noticeIds.has(e.notice))
        issue(['transitions', i, 'effects', j], `unknown notice "${e.notice}"`);
      if ((e.kind === 'startClock' || e.kind === 'stopClock') && !clockIds.has(e.clock))
        issue(['transitions', i, 'effects', j], `unknown clock "${e.clock}"`);
    });
  });

  const checkSlots = (text: string, path: (string | number)[]) => {
    for (const [, slot] of text.matchAll(SLOT))
      if (!(NOTICE_SLOTS as readonly string[]).includes(slot))
        issue(
          path,
          `unknown slot {${slot}}; allowed: ${NOTICE_SLOTS.map((s) => `{${s}}`).join(' ')}`
        );
  };
  d.notices.forEach((n, i) => {
    checkSlots(n.subject, ['notices', i, 'subject']);
    checkSlots(n.body, ['notices', i, 'body']);
    for (const [state, v] of Object.entries(n.variants ?? {})) {
      checkSlots(v.subject, ['notices', i, 'variants', state, 'subject']);
      checkSlots(v.body, ['notices', i, 'variants', state, 'body']);
    }
  });

  d.publicActions.forEach((a, i) => {
    a.fields.forEach((f, j) => {
      if (!fieldIds.has(f)) issue(['publicActions', i, 'fields', j], `unknown field "${f}"`);
    });
    if (a.moveTo === undefined) return;
    const to = states.get(a.moveTo);
    if (!to) issue(['publicActions', i, 'moveTo'], `unknown state "${a.moveTo}"`);
    else if (!to.needsReview)
      issue(
        ['publicActions', i, 'moveTo'],
        `a public action may only move a case into a needsReview state`
      );
  });
});

export type ProcessDefinition = z.infer<typeof processDefinitionSchema>;
export type ProcessEffect = z.infer<typeof effectSchema>;
