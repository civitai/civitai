import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { servablePictureSql, servablePictureText } from './profile-picture-clear.db';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';

const db = new Kysely<object>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('servablePictureSql', () => {
  it('binds each placeholder of servablePictureText to its parameter, never inlined', () => {
    const { sql, parameters } = servablePictureSql().compile(db);
    expect(parameters).toEqual([
      OWNER_HIDDEN_REVIEWS,
      KNIGHTS_VOTE_NSFW_LEVEL_REASON,
      'permanent',
      'permanent',
      60,
    ]);
    expect(sql).not.toContain(KNIGHTS_VOTE_NSFW_LEVEL_REASON);
    expect(sql.match(/\$\d+/g)).toHaveLength(servablePictureText.match(/\$\d+/g)!.length);
  });

  it.each(['i.id = $1', 'i.id = $6', 'i.id = $0'])(
    'throws on %s, a placeholder with no parameter',
    (text) => {
      expect(() => servablePictureSql(text)).toThrow('has no parameter');
    }
  );

  it('accepts a placeholder that has one (control)', () => {
    expect(servablePictureSql('i.id = $5').compile(db).parameters).toEqual([60]);
  });
});
