import { describe, expect, it } from 'vitest';
import { decodeEvent } from '~/server/registry-adapter/grpc';
import { jsonObjectOrUndefined, subscribeRequest } from '~/server/registry-adapter/protocol';

/**
 * `jsonObjectOrUndefined`: the one rule a `meta` is read by, a request's (`subscribeRequest`) and
 * an event's (`decodeEvent`). A JSON object passes; an array, `null` and a primitive are nothing.
 */
describe('jsonObjectOrUndefined', () => {
  it('passes an object, and gives undefined for an array, null and each primitive', () => {
    expect(jsonObjectOrUndefined({ head: { seq: 7 } })).toEqual({ head: { seq: 7 } });
    expect(jsonObjectOrUndefined({})).toEqual({});
    for (const v of [[], [1], null, undefined, 7, 'x', true]) {
      expect({ v, out: jsonObjectOrUndefined(v) }).toEqual({ v, out: undefined });
    }
  });

  it("a request's meta: an object is kept, anything else is none (as before)", () => {
    const meta = (raw: string) =>
      subscribeRequest({ schema: 's', cursor: '', urns: [], filter: '', meta: raw }).meta;
    expect(meta('{"region":"x"}')).toEqual({ region: 'x' });
    for (const raw of ['[1]', 'null', '7', '"x"', 'not json', '']) {
      expect({ raw, meta: meta(raw) }).toEqual({ raw, meta: undefined });
    }
  });

  it("an event's meta off the wire: an object is kept, anything else is none", () => {
    // Event.live = 3 (cursor "ab"), then Event.meta = 5 holding the JSON text.
    const live = (metaHex: string) => decodeEvent(Buffer.from(`1a040a026162${metaHex}`, 'hex'));
    expect(live('2a07' + Buffer.from('{"a":1}').toString('hex'))).toEqual({
      type: 'live',
      cursor: 'ab',
      meta: { a: 1 },
    });
    for (const json of ['[1]', 'null', '7']) {
      const hex = Buffer.from(json).toString('hex');
      const len = (hex.length / 2).toString(16).padStart(2, '0');
      expect({ json, ev: live(`2a${len}${hex}`) }).toEqual({
        json,
        ev: { type: 'live', cursor: 'ab' },
      });
    }
  });
});
