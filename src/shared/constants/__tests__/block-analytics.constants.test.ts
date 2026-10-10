import { describe, expect, it } from 'vitest';

import { parseManifestAnalytics } from '../block-analytics.constants';

/**
 * `parseManifestAnalytics` — the custom-events declaration parser. Pins that it
 * is TOTAL (never throws), ALL OR NOTHING (any error empties `events`) and that
 * its error list is BOUNDED. The validator suite pins each message's wording.
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

  describe('all or nothing', () => {
    // A VALID sibling event sits beside each invalid declaration: any error must
    // empty `events`, so no reader can act on part of a declaration that failed.
    const SAVED = { properties: { kind: { type: 'enum', values: ['draft', 'final'] } } };
    it.each([
      ['an invalid event name', { BadName: {} }],
      ['a free-text property type', { searched: { properties: { query: { type: 'string' } } } }],
      [
        'a duplicate enum value',
        { shared: { properties: { t: { type: 'enum', values: ['x', 'x'] } } } },
      ],
      ['an unknown event key', { opened: { label: 'Opened' } }],
      ['an over-long description', { opened: { description: 'd'.repeat(201) } }],
      ['an invalid property name', { opened: { properties: { 'Bad-Name': { type: 'number' } } } }],
      [
        'an extra key on a number property',
        { opened: { properties: { n: { type: 'number', values: ['1'] } } } },
      ],
    ])('declares nothing when a sibling has %s', (_label, invalid) => {
      const parsed = parseManifestAnalytics({
        analytics: { events: { saved: SAVED, ...invalid } },
      });
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.events.size).toBe(0);
    });

    it('declares nothing when analytics carries an unknown key beside valid events', () => {
      const parsed = parseManifestAnalytics({ analytics: { events: { saved: SAVED }, extra: 1 } });
      expect(parsed.errors).toEqual([
        'analytics.extra is not allowed (analytics takes only events)',
      ]);
      expect(parsed.events.size).toBe(0);
    });

    it('reports every independent error, in declaration order', () => {
      const parsed = parseManifestAnalytics({
        analytics: {
          events: {
            saved: SAVED,
            BadName: {},
            searched: { properties: { query: { type: 'string' } } },
            shared: { properties: { target: { type: 'enum', values: ['x', 'x'] } } },
            opened: { label: 'Opened' },
          },
        },
      });
      expect(parsed.errors).toEqual([
        'analytics.events key "BadName" must be lowercase snake_case: a letter, then up to 63 of a-z, 0-9 or _',
        'analytics.events.searched.properties.query.type must be one of enum, number, boolean (free-text strings are not allowed — declare an enum)',
        'analytics.events.shared.properties.target.values[1] duplicates an earlier value ("x")',
        'analytics.events.opened.label is not allowed (an event takes only description and properties)',
      ]);
    });
  });

  describe('error bounds', () => {
    it('reports at most one error per enum property — the first bad value', () => {
      const parsed = parseManifestAnalytics({
        analytics: {
          events: {
            picked: {
              properties: {
                tone: { type: 'enum', values: ['warm', '', 'q'.repeat(65), 'warm', 7] },
              },
            },
          },
        },
      });
      expect(parsed.errors).toEqual([
        'analytics.events.picked.properties.tone.values[1] must be a non-empty string of at most 64 characters',
      ]);
    });

    it('caps the error list and summarises the rest', () => {
      // 30 independent errors: one unknown key on each of 30 events.
      const events = Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`e_${i}`, { label: `x${i}` }])
      );
      const { errors } = parseManifestAnalytics({ analytics: { events } });
      expect(errors).toHaveLength(21);
      expect(errors[19]).toBe(
        'analytics.events.e_19.label is not allowed (an event takes only description and properties)'
      );
      expect(errors[20]).toBe('…and 10 more analytics errors');
    });

    it('keeps a maximal hostile declaration to a small error payload', () => {
      // 50 events × 10 properties × 50 bad values: unbounded, this is 25,000 errors.
      const props = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `p_${i}`,
          { type: 'enum', values: Array.from({ length: 50 }, () => '') },
        ])
      );
      const events = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`e_${i}`, { properties: props }])
      );
      const { errors } = parseManifestAnalytics({ analytics: { events } });
      expect(errors).toHaveLength(21);
      expect(errors[20]).toBe('…and 480 more analytics errors');
      expect(errors.join('\n').length).toBeLessThan(4000);
    });

    it('bounds an attacker-sized unknown key in the error message', () => {
      const key = 'K'.repeat(5000);
      const [message] = parseManifestAnalytics({
        analytics: { events: { tapped: { [key]: 1 } } },
      }).errors;
      expect(message.length).toBeLessThan(200);
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
