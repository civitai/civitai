import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { CasePartyActionInput, CasePartyViewInput } from '@civitai/moderation';
import {
  processDefinitionSchema,
  type ProcessDefinition,
} from '@civitai/moderation/process-definition';
import type { DB } from '@civitai/db-schema/kysely';
import { resolveAccessToken } from '@civitai/db-queries/access-token';
import { casesDb, type CasesDb } from './cases.db';
import { publicDefinition } from './definitions';
import { IntakeRefusedError, submitterRole } from './intake';
import { checkIntakeValues, submittedUrls, targetsFromUrls } from './intake-values';
import { createIntakeRateLimit } from './intake-rate-limit';

export type CasePartyDeps = {
  db: CasesDb;
  /** The main database, where link tokens live. The primary, so a revoke holds on the next request. */
  mainDb: Kysely<DB>;
  rateLimit: (key: string) => void;
  now?: () => Date;
};

// One answer for a bad token, a token for another case and an unknown reference, so the page can't be
// used to learn which references exist.
const noAccess = () =>
  Object.assign(new Error('This link has expired or is not valid.'), { status: 404, public: true });

/**
 * The party a link opens, checked against the case in the path: a token is bound to one party of one
 * case, and a token for any other case opens nothing here.
 */
async function openParty(input: CasePartyViewInput, deps: CasePartyDeps) {
  deps.rateLimit(input.ip);
  const token = await resolveAccessToken(deps.mainDb, input.token, 'CaseParty', deps.now?.());
  if (!token) throw noAccess();
  const row = await deps.db
    .selectFrom('case_party as p')
    .innerJoin('case_record as c', 'c.id', 'p.case_id')
    .innerJoin('process_definition_version as v', 'v.id', 'c.definition_version_id')
    .select([
      'p.id as partyId',
      'p.role',
      'p.user_id as partyUserId',
      'c.id as caseId',
      'c.public_ref',
      'c.state',
      'c.received_at',
      'c.due_at',
      'v.definition',
    ])
    .where('p.id', '=', token.resourceId)
    .where('c.public_ref', '=', input.publicRef)
    .executeTakeFirst();
  if (!row) throw noAccess();
  const parsed = processDefinitionSchema.safeParse(row.definition);
  if (!parsed.success)
    throw Object.assign(new Error('This case cannot be shown.'), { status: 409, public: true });
  return { ...row, caseId: Number(row.caseId), partyId: Number(row.partyId), def: parsed.data };
}

type Party = Awaited<ReturnType<typeof openParty>>;

/**
 * The targets this party may see: all of them for the party who filed the case, and otherwise only
 * those uploaded by the party's account (an uploader sees their own items, never the rest of a claim).
 */
async function partyTargets(db: CasesDb, party: Party) {
  let q = db
    .selectFrom('case_target')
    .select(['url', 'state'])
    .where('case_id', '=', party.caseId)
    .orderBy('id');
  if (party.role !== submitterRole(party.def.key)) {
    if (party.partyUserId === null) return [];
    q = q.where('uploader_user_id', '=', party.partyUserId);
  }
  return q.execute();
}

const partyActions = (def: ProcessDefinition, role: string, state: string) => {
  const fields = publicDefinition(def).fields;
  return def.publicActions
    .filter((a) => a.role === role && actionOpenIn(def, a, state))
    .map((a) => ({
      id: a.id,
      label: a.label,
      fields: a.fields.map((id) => fields.find((f) => f.id === id)!),
    }));
};

/**
 * What a party's link shows: the request, its state, the party's own items and the actions open to the
 * party's role. No contact details of anyone, and nothing a moderator wrote.
 */
export async function casePartyView(input: CasePartyViewInput, deps: CasePartyDeps) {
  const party = await openParty(input, deps);
  const state = party.def.states.find((s) => s.id === party.state);
  return {
    publicRef: party.public_ref,
    title: party.def.title,
    role: party.role,
    state: { id: party.state, label: state?.label ?? party.state, terminal: !!state?.terminal },
    receivedAt: new Date(party.received_at as unknown as string).toISOString(),
    items: await partyTargets(deps.db, party),
    actions: partyActions(party.def, party.role, party.state),
  };
}

/**
 * Records one public action by a party: the event it names, any new items it adds, and the state it
 * moves to. The time recorded is the time of this call, which is the filing time the statute counts.
 */
export async function casePartyAction(input: CasePartyActionInput, deps: CasePartyDeps) {
  const party = await openParty(input, deps);
  const { def } = party;
  const action = def.publicActions.find((a) => a.id === input.actionId && a.role === party.role);
  if (!action)
    throw Object.assign(new Error('This action is not open to you.'), {
      status: 403,
      public: true,
    });
  deps.rateLimit(`party:${party.partyId}`);

  const actionDef = { ...def, fields: def.fields.filter((f) => action.fields.includes(f.id)) };
  const fieldErrors = checkIntakeValues(actionDef, input.values);
  if (Object.keys(fieldErrors).length) throw new IntakeRefusedError(fieldErrors);
  const at = deps.now?.() ?? new Date();
  const added = targetsFromUrls(submittedUrls(actionDef, input.values));

  return deps.db.transaction().execute(async (tx) => {
    // Locked, so a moderator's move and this action can't interleave: the state checked is the state
    // the action is recorded against.
    const current = await tx
      .selectFrom('case_record')
      .select('state')
      .where('id', '=', party.caseId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const seen = await tx
      .selectFrom('case_event')
      .select('type')
      .where('case_id', '=', party.caseId)
      .where(sql<boolean>`data->>'submissionId' = ${input.submissionId}`)
      .executeTakeFirst();
    if (seen) return { recorded: action.records, state: current.state };
    if (!actionOpenIn(def, action, current.state))
      throw Object.assign(new Error(closedStepMessage(def)), { status: 409, public: true });

    const existing = new Set(
      (
        await tx
          .selectFrom('case_target')
          .select('url')
          .where('case_id', '=', party.caseId)
          .execute()
      ).map((t) => t.url)
    );
    for (const t of added.filter((t) => !existing.has(t.url)))
      await tx
        .insertInto('case_target')
        .values({
          case_id: party.caseId,
          url: t.url,
          entity_type: t.entityType,
          entity_id: t.entityId,
        })
        .execute();
    await tx
      .insertInto('case_event')
      .values({
        case_id: party.caseId,
        at: at.toISOString(),
        type: action.records,
        data: JSON.stringify({
          partyId: party.partyId,
          action: action.id,
          submissionId: input.submissionId,
          values: input.values,
        }),
      })
      .execute();
    if (action.moveTo)
      await tx
        .updateTable('case_record')
        .set({ state: action.moveTo, updated_at: sql`now()` })
        .where('id', '=', party.caseId)
        .execute();
    return { recorded: action.records, state: action.moveTo ?? current.state };
  });
}

/** Legal's wording (2026-11-20): the mailbox stays a full path for anything the page no longer takes. */
const closedStepMessage = (def: ProcessDefinition) =>
  `This step is closed. To send us more about this case, email ${def.mailbox} with your case number.`;

/** An action is open in its `from` states, or, with none listed, in any state that is not terminal. */
function actionOpenIn(
  def: ProcessDefinition,
  action: ProcessDefinition['publicActions'][number],
  state: string
) {
  if (action.from) return action.from.includes(state);
  return !def.states.find((s) => s.id === state)?.terminal;
}

// Per ip, and per party for actions (keys `party:<id>`). An unresolved ip is left to the main app's limit.
const limitPerKey = createIntakeRateLimit({ limit: 120, windowMs: 3_600_000 });
const limitPerIp = (key: string) => {
  if (key !== 'unknown') limitPerKey(key);
};

export const defaultCasePartyDeps = (mainDb: Kysely<DB>): CasePartyDeps => ({
  db: casesDb(),
  mainDb,
  rateLimit: limitPerIp,
});
