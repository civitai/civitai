import { z } from 'zod';

/**
 * A process definition is the data behind one intake process (a DMCA notice, a counter-notice, ...): the form
 * it asks for, the states a case moves through, its clocks and the notices it sends. Definitions are stored as
 * versioned rows and a case pins the version it started on.
 *
 * What a definition may not do is enforced here, not left to whoever writes the row:
 * - effects come from a fixed set (`effectSchema`); an unknown one fails to parse, and a reroute to another
 *   process always escalates to Legal;
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

/** `submission` renders the fields the party submitted (a counter-notice copied to the claimant, say). */
export const NOTICE_SLOTS = [
  'caseRef',
  'items',
  'continueLink',
  'receivedAt',
  'submission',
  /** The definition's own public title, so one shared text can name the request it answers. */
  'requestType',
] as const;

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
  /** Move the case to another process (a removal request that is really a DMCA notice, say). */
  z.strictObject({ kind: z.literal('rerouteTo'), process: id }),
]);

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
        /** Unavailable until this clock's window opens (a restore no earlier than business day 10). */
        notBefore: id.optional(),
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
          /**
           * `receipt` runs from the case's original receivedAt, even when the case was rerouted here from
           * another process (a statutory deadline runs from the valid request, whatever form it came on).
           * `effect` runs from the transition whose startClock effect starts it.
           */
          startsOn: z.enum(['receipt', 'effect']).default('effect'),
          hours: z.number().int().positive().optional(),
          businessDays: z.number().int().positive().optional(),
          /** Where a window opens, in the clock's own unit; the duration is its deadline. */
          opensAfter: z.number().int().positive().optional(),
          warnBeforeHours: z.number().int().positive().optional(),
        })
        .refine((c) => (c.hours === undefined) !== (c.businessDays === undefined), {
          message: 'a clock runs for either hours or businessDays',
        })
        .refine(
          (c) => c.opensAfter === undefined || c.opensAfter < (c.hours ?? c.businessDays ?? 0),
          {
            message: 'a window must open before its deadline',
          }
        )
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
        /** The states the action is open in. Unset: every state that is not terminal. */
        from: z.array(id).optional(),
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
      if (e.kind === 'rerouteTo' && e.process === d.key)
        issue(['transitions', i, 'effects', j], 'a process cannot reroute to itself');
    });
    if (t.notBefore !== undefined) {
      const clock = d.clocks.find((c) => c.id === t.notBefore);
      if (!clock) issue(['transitions', i, 'notBefore'], `unknown clock "${t.notBefore}"`);
      else if (clock.opensAfter === undefined)
        issue(['transitions', i, 'notBefore'], `clock "${t.notBefore}" has no opensAfter`);
    }
    if (
      t.effects.some((e) => e.kind === 'rerouteTo') &&
      !t.effects.some((e) => e.kind === 'escalateToLegal')
    )
      issue(['transitions', i, 'effects'], 'a reroute must also escalate to Legal');
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
    a.from?.forEach((s, j) => {
      if (!states.has(s)) issue(['publicActions', i, 'from', j], `unknown state "${s}"`);
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

/** Whether a state ends a case. The case tick checks the same thing in SQL (case-tick.ts). */
export const isTerminalState = (def: Pick<ProcessDefinition, 'states'>, id: string) =>
  !!def.states.find((s) => s.id === id)?.terminal;
export type ProcessEffect = z.infer<typeof effectSchema>;
