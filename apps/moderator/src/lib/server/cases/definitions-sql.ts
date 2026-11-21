import { createHash, randomBytes } from 'node:crypto';
import type { processDefinitionSchema } from '@civitai/moderation/process-definition';

/**
 * The SQL that stores takedown request definitions as new versions, for a person to apply by hand
 * (cases/definitions-apply.ts prints it). Every definition must parse, or this throws and nothing is
 * produced. A definition is stored disabled unless named in `enable`, so storing a form and opening it
 * to the public are separate steps. Without `commit` the SQL ends in ROLLBACK: a dry run whose
 * read-back shows what a commit would store.
 */
export function definitionsSql(
  raw: string,
  {
    schema,
    actor,
    enable = [],
    commit = false,
  }: {
    /** Passed in rather than imported: the hand-run script loads it as CommonJS (see the script). */
    schema: typeof processDefinitionSchema;
    actor: number;
    enable?: string[];
    commit?: boolean;
  }
) {
  if (!Number.isInteger(actor) || actor <= 0) throw new Error('actor must be a user id');
  const input: unknown = JSON.parse(raw);
  if (!Array.isArray(input)) throw new Error('expected an array of definitions');
  const defs = input.map((d, i) => {
    const parsed = schema.safeParse(d);
    if (!parsed.success) throw new Error(`definition ${i} does not parse: ${parsed.error.message}`);
    return parsed.data;
  });
  const keys = defs.map((d) => d.key);
  if (new Set(keys).size !== keys.length) throw new Error('duplicate keys');
  for (const k of enable)
    if (!keys.includes(k)) throw new Error(`enable names ${k}, which is not in the file`);

  const sha = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const dollar = (text: string) => {
    let tag: string;
    do tag = `def_${randomBytes(4).toString('hex')}`;
    while (text.includes(tag));
    return `$${tag}$${text}$${tag}$`;
  };

  const out: string[] = ['BEGIN;'];
  for (const d of defs)
    out.push(
      `INSERT INTO process_definition (key) VALUES (${literal(
        d.key
      )}) ON CONFLICT (key) DO NOTHING;`,
      `WITH v AS (
  INSERT INTO process_definition_version (definition_id, definition, created_by_id, note)
  SELECT id, ${dollar(JSON.stringify(d))}::jsonb, ${actor}, ${literal(`definitions ${sha}`)}
  FROM process_definition WHERE key = ${literal(d.key)}
  RETURNING id, definition_id
)
UPDATE process_definition p SET current_version_id = v.id, enabled = ${enable.includes(d.key)}
FROM v WHERE p.id = v.definition_id;`
    );
  out.push(
    `-- Read-back: expect ${defs.length} row(s), each with note 'definitions ${sha}'.
SELECT p.key, p.enabled, v.note, v.definition->>'title' AS title, md5(v.definition::text) AS md5
FROM process_definition p JOIN process_definition_version v ON v.id = p.current_version_id
WHERE p.key IN (${keys.map(literal).join(', ')}) ORDER BY p.key;`,
    commit ? 'COMMIT;' : 'ROLLBACK; -- dry run: pass --commit to store'
  );
  return { sql: out.join('\n'), sha, keys };
}
