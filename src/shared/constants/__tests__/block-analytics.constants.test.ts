import { describe, expect, it } from 'vitest';

import { parseManifestAnalytics } from '../block-analytics.constants';

/**
 * `parseManifestAnalytics` — the custom-events declaration parser. A later
 * consumer reads `events` on a hot path, so beyond the rules themselves this pins
 * that the parser is TOTAL (never throws, whatever it is handed) and that it
 * STRIPS an invalid declaration rather than keeping a repaired one.
 *
 * Fixture counts (3 enum values, 2 events, …) are chosen to differ from every
 * bound the module exports, so a mutant that returns a bound cannot pass.
 */

const VALID = {
  analytics: {
    events: {
      generate_clicked: {
        description: 'User pressed Generate',
        properties: {
          mode: { type: 'enum', values: ['txt2img', 'img2img', 'inpaint'] },
          batch: { type: 'number' },
          advanced: { type: 'boolean' },
        },
      },
      level_up: {},
    },
  },
};

/** The parsed declaration as plain data, so a test can compare it to a literal. */
function plain(manifest: unknown) {
  const { events } = parseManifestAnalytics(manifest);
  return Object.fromEntries(
    [...events].map(([name, event]) => [
      name,
      { ...event, properties: Object.fromEntries(event.properties) },
    ])
  );
}

describe('parseManifestAnalytics', () => {
  it('round-trips a valid declaration into a normalised map', () => {
    const { errors } = parseManifestAnalytics(VALID);
    expect(errors).toEqual([]);
    expect(plain(VALID)).toEqual({
      generate_clicked: {
        description: 'User pressed Generate',
        properties: {
          mode: { type: 'enum', values: ['txt2img', 'img2img', 'inpaint'] },
          batch: { type: 'number' },
          advanced: { type: 'boolean' },
        },
      },
      // No `description` key at all when none was declared — not `undefined`.
      level_up: { properties: {} },
    });
    expect(Object.keys(parseManifestAnalytics(VALID).events.get('level_up') ?? {})).toEqual([
      'properties',
    ]);
  });

  it('returns an empty declaration with no errors when analytics is absent', () => {
    const parsed = parseManifestAnalytics({ blockId: 'x' });
    expect(parsed.events.size).toBe(0);
    expect(parsed.errors).toEqual([]);
    expect(parseManifestAnalytics({ analytics: {} }).errors).toEqual([]);
  });

  describe('totality', () => {
    const throwingGetter = {
      get analytics(): unknown {
        throw new Error('boom');
      },
    };
    const throwingProxy = {
      analytics: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('boom');
          },
        }
      ),
    };

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['a string', 'analytics'],
      ['an array', [VALID]],
      ['analytics: null', { analytics: null }],
      ['analytics: array', { analytics: [VALID.analytics] }],
      ['analytics: string', { analytics: 'events' }],
      ['events: string', { analytics: { events: 'generate_clicked' } }],
      ['events: array', { analytics: { events: [{ name: 'x' }] } }],
      ['event: null', { analytics: { events: { tapped: null } } }],
      ['event: number', { analytics: { events: { tapped: 7 } } }],
      ['properties: array', { analytics: { events: { tapped: { properties: [1] } } } }],
      ['property: string', { analytics: { events: { tapped: { properties: { p: 'enum' } } } } }],
      [
        'values: object',
        {
          analytics: {
            events: { tapped: { properties: { p: { type: 'enum', values: { a: 1 } } } } },
          },
        },
      ],
      ['a throwing getter', throwingGetter],
      ['a throwing proxy', throwingProxy],
    ])('does not throw on %s and declares nothing', (_label, input) => {
      let parsed: ReturnType<typeof parseManifestAnalytics> | undefined;
      expect(() => {
        parsed = parseManifestAnalytics(input);
      }).not.toThrow();
      expect(parsed?.events.size).toBe(0);
    });

    it('reports the exotic-input case rather than passing it silently', () => {
      expect(parseManifestAnalytics(throwingGetter).errors).toEqual([
        'analytics could not be read',
      ]);
    });
  });

  describe('stripping', () => {
    it('keeps valid events and drops every invalid one, reporting each', () => {
      const parsed = parseManifestAnalytics({
        analytics: {
          events: {
            saved: { properties: { kind: { type: 'enum', values: ['draft', 'final'] } } },
            BadName: {},
            searched: { properties: { query: { type: 'string' } } },
            shared: { properties: { target: { type: 'enum', values: ['x', 'x'] } } },
            opened: { label: 'Opened' },
          },
        },
      });
      expect([...parsed.events.keys()]).toEqual(['saved']);
      expect(parsed.errors).toHaveLength(4);
    });

    it('drops the whole event, not just the bad property, when one property is invalid', () => {
      const parsed = parseManifestAnalytics({
        analytics: {
          events: {
            tapped: { properties: { ok_prop: { type: 'number' }, bad_prop: { type: 'date' } } },
          },
        },
      });
      expect(parsed.events.has('tapped')).toBe(false);
    });

    it('drops the whole catalog when too many events are declared', () => {
      const events = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`e_${i}`, {}]));
      expect(parseManifestAnalytics({ analytics: { events } }).events.size).toBe(0);
    });

    it('drops an enum property that repeats a value', () => {
      const parsed = parseManifestAnalytics({
        analytics: {
          events: {
            shared: { properties: { target: { type: 'enum', values: ['a', 'b', 'a'] } } },
          },
        },
      });
      expect(parsed.events.size).toBe(0);
    });
  });

  it('answers only for declared names, including ones that shadow Object.prototype', () => {
    const { events } = parseManifestAnalytics({
      analytics: { events: { constructor: { properties: { valueof: { type: 'number' } } } } },
    });
    expect(events.get('constructor')?.properties.get('valueof')).toEqual({ type: 'number' });
    expect(events.has('hasownproperty')).toBe(false);
    expect(events.get('constructor')?.properties.has('tostring')).toBe(false);
  });

  it('bounds an attacker-sized key in the error message', () => {
    const name = 'Q'.repeat(5000);
    const [message] = parseManifestAnalytics({ analytics: { events: { [name]: {} } } }).errors;
    expect(message.length).toBeLessThan(200);
  });
});
