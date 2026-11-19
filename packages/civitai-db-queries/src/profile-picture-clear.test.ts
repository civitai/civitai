import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  servablePictureParameters,
  servablePictureSql,
  servablePictureText,
} from './profile-picture-clear.db';

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
    const placeholders = [...servablePictureText.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(parameters).toEqual(placeholders.map((n) => servablePictureParameters[n - 2]));
    expect(sql).not.toContain(String(servablePictureParameters[1]));
  });

  it.each(['i.id = $1', 'i.id = $6', 'i.id = $0'])(
    'throws on %s, a placeholder with no parameter',
    (text) => {
      expect(() => servablePictureSql(text)).toThrow('has no parameter');
    }
  );

  it('accepts a placeholder that has one (control)', () => {
    expect(servablePictureSql('i.id = $5').compile(db).parameters).toEqual([
      servablePictureParameters[3],
    ]);
  });
});
