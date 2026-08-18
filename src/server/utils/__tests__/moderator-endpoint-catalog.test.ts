import { describe, expect, it } from 'vitest';
import { jsonSafe } from '~/server/utils/moderator-endpoint-catalog';

// `getServerSideProps` refuses to serialise `undefined` and fails the whole page rather than the one
// field. That broke /moderator/api three times — in specToDoc, on `privileged`, and a zod-projected
// schema is a third surface nobody writes by hand. These pin the boundary normalisation instead.
describe('jsonSafe', () => {
  it('drops undefined keys and keeps everything else', () => {
    const out = jsonSafe({ a: 1, b: undefined, c: null, d: '', e: 0, f: false });
    expect('b' in out).toBe(false);
    expect(out).toEqual({ a: 1, c: null, d: '', e: 0, f: false });
  });

  it('recurses into nested objects and arrays', () => {
    const out = jsonSafe({
      doc: { summary: 'x', privileged: undefined, params: [{ name: 'a', description: undefined }] },
      list: [1, undefined, { z: undefined, y: 2 }],
    });
    expect(JSON.stringify(out)).not.toContain('undefined');
    expect('privileged' in (out.doc as object)).toBe(false);
    expect('description' in ((out.doc as { params: object[] }).params[0] as object)).toBe(false);
    expect((out.doc as { params: object[] }).params).toHaveLength(1);
    expect((out.list as unknown[])[1]).toBeNull();
    expect((out.list as unknown[])[2]).toEqual({ y: 2 });
  });

  it('leaves a Date alone rather than flattening it to {}', () => {
    // Dates ARE serialisable by getServerSideProps' rules; treating them as plain objects would strip
    // them to `{}` and silently lose the value.
    const date = new Date('2020-01-01T00:00:00.000Z');
    expect(jsonSafe({ at: date }).at).toBeInstanceOf(Date);
  });
});
