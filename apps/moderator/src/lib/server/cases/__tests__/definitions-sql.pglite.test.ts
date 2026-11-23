import { beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { CasesDb } from '../cases.db';
import { casesPglite } from './cases-pglite.harness';
import { processDefinitionSchema as schema } from '@civitai/moderation/process-definition';
import { definitionsSql } from '../definitions-sql';
import { enabledDefinitions } from '../definitions';

const def = (key: string, title = `Title ${key}`) => ({
  key,
  title,
  mailbox: 'dmca@civitai.com',
  fields: [{ id: 'work', label: "The work's name", kind: 'text', required: true }],
  states: [{ id: 'received', label: 'Received' }],
  initialState: 'received',
});

let pg: PGlite;
let db: CasesDb;
beforeEach(async () => {
  ({ pg, db } = await casesPglite());
});

describe('definitionsSql', () => {
  it('stores each definition, opens only the ones named, and reads back', async () => {
    const raw = JSON.stringify([def('dmca-notice'), def('likeness-claim')]);
    const { sql } = definitionsSql(raw, {
      schema,
      actor: 7,
      enable: ['dmca-notice'],
      commit: true,
    });
    await pg.exec(sql);
    const served = await enabledDefinitions({ db });
    expect(served.map((d) => d.definition.key)).toEqual(['dmca-notice']);
    const stored = await pg.query('SELECT count(*)::int AS n FROM process_definition');
    expect(stored.rows[0]).toEqual({ n: 2 });
  });

  it('a dry run stores nothing', async () => {
    await pg.exec(definitionsSql(JSON.stringify([def('dmca-notice')]), { schema, actor: 7 }).sql);
    const stored = await pg.query('SELECT count(*)::int AS n FROM process_definition');
    expect(stored.rows[0]).toEqual({ n: 0 });
  });

  it('a second run appends a version and serves the newer one', async () => {
    const run = (title: string) =>
      pg.exec(
        definitionsSql(JSON.stringify([def('dmca-notice', title)]), {
          schema,
          actor: 7,
          enable: ['dmca-notice'],
          commit: true,
        }).sql
      );
    await run('First');
    await run('Second');
    const versions = await pg.query('SELECT count(*)::int AS n FROM process_definition_version');
    expect(versions.rows[0]).toEqual({ n: 2 });
    expect((await enabledDefinitions({ db }))[0].definition.title).toBe('Second');
  });

  it('refuses a file with a definition that does not parse', () => {
    const bad = JSON.stringify([{ ...def('dmca-notice'), initialState: 'nowhere' }]);
    expect(() => definitionsSql(bad, { schema, actor: 7 })).toThrow(/does not parse/);
  });
});
