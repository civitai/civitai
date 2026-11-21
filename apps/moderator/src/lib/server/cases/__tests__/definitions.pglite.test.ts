import { beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { CasesDb } from '../cases.db';
import { casesPglite } from './cases-pglite.harness';
import { enabledDefinitions, publicDefinition } from '../definitions';

const minimal = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Title ${key}`,
  mailbox: 'dmca@civitai.com',
  fields: [{ id: 'work', label: 'The work', kind: 'textarea', required: true }],
  states: [{ id: 'received', label: 'Received' }],
  initialState: 'received',
  notices: [{ id: 'ack', recipientRole: 'claimant', subject: 'Got it', body: 'Ref {caseRef}' }],
  ...extra,
});

let pg: PGlite;
let db: CasesDb;
beforeEach(async () => {
  ({ pg, db } = await casesPglite());
});

async function store(key: string, definition: unknown, enabled = true) {
  const d = await pg.query<{ id: number }>(
    'INSERT INTO process_definition (key, enabled) VALUES ($1, $2) RETURNING id',
    [key, enabled]
  );
  const v = await pg.query<{ id: number }>(
    'INSERT INTO process_definition_version (definition_id, definition, created_by_id) VALUES ($1, $2, 1) RETURNING id',
    [d.rows[0].id, JSON.stringify(definition)]
  );
  await pg.query('UPDATE process_definition SET current_version_id = $1 WHERE id = $2', [
    v.rows[0].id,
    d.rows[0].id,
  ]);
}

describe('enabledDefinitions', () => {
  it('serves an enabled definition at its current version', async () => {
    await store('dmca-notice', minimal('dmca-notice'));
    const defs = await enabledDefinitions({ db });
    expect(defs.map((d) => d.definition.key)).toEqual(['dmca-notice']);
  });

  it('leaves out a disabled definition', async () => {
    await store('dmca-notice', minimal('dmca-notice'), false);
    expect(await enabledDefinitions({ db })).toEqual([]);
  });

  it('leaves out a stored version that no longer parses, rather than serving it', async () => {
    await store('broken', { ...minimal('broken'), initialState: 'nowhere' });
    await store('dmca-notice', minimal('dmca-notice'));
    const defs = await enabledDefinitions({ db });
    expect(defs.map((d) => d.definition.key)).toEqual(['dmca-notice']);
  });

  it('leaves out a version whose key does not match the row it hangs from', async () => {
    await store('dmca-notice', minimal('likeness-claim'));
    expect(await enabledDefinitions({ db })).toEqual([]);
  });
});

describe('publicDefinition', () => {
  it('carries only the public parts: the fields and the form\'s own contact mailbox', () => {
    const view = publicDefinition(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      minimal('dmca-notice') as any
    );
    expect(Object.keys(view).sort()).toEqual(['fields', 'key', 'mailbox', 'title']);
    expect(view.mailbox).toBe('dmca@civitai.com');
  });
});
