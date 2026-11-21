import {
  processDefinitionSchema,
  type ProcessDefinition,
} from '@civitai/moderation/process-definition';
import { casesDb, type CasesDb } from './cases.db';

/**
 * The enabled takedown request definitions, each at its current version. A stored version that no longer
 * parses is left out rather than served half-understood: a form whose rules this code cannot read must
 * not take submissions. Import-batch bookkeeping rows are always disabled, so they never appear here.
 */
export async function enabledDefinitions({ db = casesDb() }: { db?: CasesDb } = {}) {
  const rows = await db
    .selectFrom('process_definition as d')
    .innerJoin('process_definition_version as v', 'v.id', 'd.current_version_id')
    .select(['d.key', 'v.id as versionId', 'v.definition'])
    .where('d.enabled', '=', true)
    .orderBy('d.key')
    .execute();
  const out: { versionId: number; definition: ProcessDefinition }[] = [];
  for (const row of rows) {
    const parsed = processDefinitionSchema.safeParse(row.definition);
    if (parsed.success && parsed.data.key === row.key)
      out.push({ versionId: Number(row.versionId), definition: parsed.data });
    else console.error('case definition skipped: does not parse', { key: row.key });
  }
  return out;
}

/** One enabled definition by key, or null. */
export async function enabledDefinition(key: string, opts: { db?: CasesDb } = {}) {
  return (await enabledDefinitions(opts)).find((d) => d.definition.key === key) ?? null;
}

/**
 * What the public form page needs, and nothing more: no states, transitions or notice texts, which are
 * moderator-side. The mailbox is the form's public contact address, the one its mail replies to.
 */
export function publicDefinition(def: ProcessDefinition) {
  return {
    key: def.key,
    title: def.title,
    mailbox: def.mailbox,
    fields: def.fields.map(({ id, label, kind, required, help, options }) => ({
      id,
      label,
      kind,
      required,
      help,
      options,
    })),
  };
}
export type PublicDefinition = ReturnType<typeof publicDefinition>;
