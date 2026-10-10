import { describe, expect, it } from 'vitest';

import { parseManifestAnalytics } from '../block-analytics.constants';

/**
 * `parseManifestAnalytics` — the custom-events declaration parser. Pins that it
 * is TOTAL (never throws) and STRIPS an invalid event rather than repairing it.
 * The validator suite pins each error message; this one pins `events` (plus the
 * messages of one stripping case).
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
      expect(parsed.errors).toEqual([
        'analytics.events key "BadName" must be lowercase snake_case: a letter, then up to 63 of a-z, 0-9 or _',
        'analytics.events.searched.properties.query.type must be one of enum, number, boolean (free-text strings are not allowed — declare an enum)',
        'analytics.events.shared.properties.target.values[1] duplicates an earlier value ("x")',
        'analytics.events.opened.label is not allowed (an event takes only description and properties)',
      ]);
    });

    // Each branch that marks an event invalid must also keep it out of `events`.
    // The validator suite cannot see this: it reads only `errors`.
    it.each([
      [
        'an extra key on a number property',
        { properties: { n: { type: 'number', values: ['1'] } } },
      ],
      ['an over-long description', { description: 'd'.repeat(201) }],
      ['an invalid property name', { properties: { 'Bad-Name': { type: 'number' } } }],
      [
        'an over-long enum value',
        { properties: { t: { type: 'enum', values: ['q'.repeat(65)] } } },
      ],
    ])('drops an event with %s', (_label, declaration) => {
      const parsed = parseManifestAnalytics({ analytics: { events: { tapped: declaration } } });
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.events.has('tapped')).toBe(false);
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

  it('answers for `constructor` only when it is declared', () => {
    // `constructor` is the one Object.prototype member the name pattern admits.
    const declared = parseManifestAnalytics({
      analytics: { events: { constructor: { properties: { constructor: { type: 'number' } } } } },
    }).events;
    expect(declared.get('constructor')?.properties.get('constructor')).toEqual({ type: 'number' });

    const undeclared = parseManifestAnalytics({
      analytics: { events: { tapped: { properties: { count: { type: 'number' } } } } },
    }).events;
    expect(undeclared.has('constructor')).toBe(false);
    expect(undeclared.get('tapped')?.properties.has('constructor')).toBe(false);
  });

  it('counts lengths in code points, as the published schema does', () => {
    // '😀' is one code point and two UTF-16 units.
    const ok = parseManifestAnalytics({
      analytics: {
        events: {
          tapped: {
            description: '😀'.repeat(200),
            properties: { mood: { type: 'enum', values: ['😀'.repeat(64)] } },
          },
        },
      },
    });
    expect(ok.errors).toEqual([]);
    expect(ok.events.has('tapped')).toBe(true);

    const over = parseManifestAnalytics({
      analytics: { events: { tapped: { description: '😀'.repeat(201) } } },
    });
    expect(over.events.has('tapped')).toBe(false);
  });

  it('bounds an attacker-sized key in the error message', () => {
    const name = 'Q'.repeat(5000);
    const [message] = parseManifestAnalytics({ analytics: { events: { [name]: {} } } }).errors;
    expect(message.length).toBeLessThan(200);
  });
});
