import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { createPollingAdapter } from '~/server/registry-adapter/cursor';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { SERVED_SCHEMAS, buildEntities } from '~/server/registry-adapter/entities';
import { newValidator } from '~/server/registry-adapter/json-schema';
import type { Entity } from '~/server/registry-adapter/protocol';
import { APP_RELEASE_SCHEMA, APP_SCHEMA, SERVICE_SCHEMA } from '~/server/registry-adapter/urn';
import { JSON_SCHEMA_DIALECT } from '~/server/registry-adapter/collection-schema';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

const OWN = [
  'urn:schema:apps.civitai.com:app@v1',
  'urn:schema:apps.civitai.com:app-release@v1',
  'urn:schema:apps.civitai.com:service@v1',
];

const listing = (over: Partial<CatalogApp['listing']>): CatalogApp['listing'] => ({
  slug: 'orbit-notes',
  kind: 'onsite',
  name: 'Orbit Notes',
  tagline: 'Notes in orbit',
  category: 'productivity-q',
  contentRating: 'x',
  iconUrl: 'https://img.example/orbit.png',
  creatorUsername: 'maker-k',
  externalUrl: null,
  sourceRepoUrl: 'https://git.example/orbit-notes',
  forkOf: null,
  ...over,
});

const manifest = (version: string) => ({
  blockId: 'orbit-notes',
  version,
  name: 'Orbit Notes',
  contentRating: 'r',
  scopes: ['storage:read'],
  storage: {
    collections: {
      cards: {
        visibility: 'shared',
        write: 'own',
        registry: 'public',
        schema: { type: 'object', properties: { stars: { type: 'integer' } } },
      },
    },
  },
});

/** Every optional field of every entity body present somewhere, and every nullable one null. */
const CATALOG: CatalogApp[] = [
  {
    listing: listing({}),
    block: {
      id: 'ab_orbit',
      blockId: 'orbit-notes',
      version: '1.1.0',
      status: 'approved',
      contentRating: 'r',
      manifest: manifest('1.1.0'),
    },
    approved: [
      {
        id: 'pubreq_1',
        version: '1.0.0',
        manifest: manifest('1.0.0'),
        bundleSha256: 'b'.repeat(64),
        commitSha: 'c'.repeat(40),
        sourceCommit: 'd'.repeat(40),
        reviewedAt: new Date('2026-10-02T03:04:05Z'),
      },
      {
        id: 'pubreq_2',
        version: '1.1.0',
        manifest: { blockId: 'orbit-notes', version: '1.1.0' },
        bundleSha256: null,
        commitSha: null,
        sourceCommit: null,
        reviewedAt: null,
      },
    ],
  },
  {
    listing: listing({
      slug: 'tide-log',
      kind: 'offsite',
      name: 'Tide Log',
      tagline: null,
      category: null,
      contentRating: null,
      iconUrl: null,
      creatorUsername: null,
      externalUrl: 'https://tide.example',
      sourceRepoUrl: null,
      forkOf: 'orbit-notes',
    }),
    block: null,
    approved: [],
  },
];

const SWITCH_ON = { ...APP_STORAGE_ENABLED_FEATURES, registryExport: true };

/** The validator of each schema entity the build published, compiled from its body. */
function compiled(sets: ReturnType<typeof buildEntities>) {
  const docs = new Map(
    (sets.get(JSON_SCHEMA_DIALECT) ?? []).map((e) => [e.urn, e.body as Record<string, unknown>])
  );
  const cache = new Map<string, ValidateFunction>();
  return (schema: string): ValidateFunction => {
    const body = docs.get(schema);
    if (!body) throw new Error(`no schema entity ${schema}`);
    let validate = cache.get(schema);
    if (!validate) {
      validate = newValidator().compile(body);
      cache.set(schema, validate);
    }
    return validate;
  };
}

describe('the schemas of our own entities', () => {
  // The schema stream is the root, JSON Schema 2020-12's own meta-schema, and each schema entity
  // claims it.
  it.each([['https://json-schema.org/draft/2020-12/schema']])(
    '🔴 the live adapter serves them on the schema stream %s, with the registry switch off',
    async (stream) => {
      const adapter = createPollingAdapter({
        namespace: 'apps.civitai.com',
        serves: SERVED_SCHEMAS,
        // As the live entrypoint builds them: the platform's own switch, which ships off.
        read: async () => buildEntities(CATALOG, { baseUrl: 'https://site.example' }),
        store: createMemorySnapshotStore(),
        pollMs: 1,
        sleep: async () => undefined,
      });
      expect(adapter.serves(stream)).toBe(true);
      const snap = await adapter.snapshot(stream, {
        signal: new AbortController().signal,
      });
      const served = [...(snap.entities as Entity[])];
      expect(served.map((e) => [e.urn, e.schemas, (e.body as { $id: unknown }).$id])).toEqual(
        OWN.map((urn) => [urn, [stream], urn])
      );
    }
  );

  // The earlier spec's schema-stream URN is no longer served: a subscription for it is a schema
  // this source has no source for, answered `end` (`subscription.test.ts` drives that).
  it('the served schemas are the root and the three entity schemas, and nothing else', () => {
    expect([...SERVED_SCHEMAS]).toEqual([
      'https://json-schema.org/draft/2020-12/schema',
      'urn:schema:apps.civitai.com:app@v1',
      'urn:schema:apps.civitai.com:app-release@v1',
      'urn:schema:apps.civitai.com:service@v1',
    ]);
    expect(SERVED_SCHEMAS).not.toContain('urn:schema:registry:schema@v1');
  });

  it.each([
    ['on', SWITCH_ON],
    ['off', APP_STORAGE_ENABLED_FEATURES],
  ])(
    '🔴 every app, release and runtime entity validates against the schema it claims (switch %s)',
    (_name, features) => {
      const sets = buildEntities(CATALOG, { baseUrl: 'https://site.example', features });
      const schemaOf = compiled(sets);
      const checked: string[] = [];
      const failures: unknown[] = [];
      for (const set of [APP_SCHEMA, APP_RELEASE_SCHEMA, SERVICE_SCHEMA]) {
        for (const e of sets.get(set) ?? []) {
          expect(e.schemas).toEqual([set]);
          const validate = schemaOf(set);
          if (!validate(e.body)) failures.push({ urn: e.urn, errors: validate.errors });
          checked.push(e.urn);
        }
      }
      expect(failures).toEqual([]);
      // Positive control on the loop: every entity of the three streams was checked.
      expect(checked).toEqual([
        'urn:apps.civitai.com:app/orbit-notes',
        'urn:apps.civitai.com:app/tide-log',
        'urn:apps.civitai.com:app/orbit-notes@1.0.0',
        'urn:apps.civitai.com:app/orbit-notes@1.1.0',
        'urn:apps.civitai.com:runtime/iframe@1',
      ]);
    }
  );

  // Coverage of the check above: a body field the catalog never fills is never validated. This
  // pins that the catalog fills every optional field the bodies have today.
  it('the catalog fills every field an app or release body can carry', () => {
    const sets = buildEntities(CATALOG, { baseUrl: 'https://site.example', features: SWITCH_ON });
    const keys = (schema: string) =>
      [...new Set((sets.get(schema) ?? []).flatMap((e) => Object.keys(e.body as object)))].sort();
    expect(keys(APP_SCHEMA)).toEqual(
      [
        'category',
        'contentRating',
        'creator',
        'externalUrl',
        'forkOf',
        'iconUrl',
        'kind',
        'name',
        'release',
        'runtime',
        'slug',
        'tagline',
      ].sort()
    );
    expect(keys(APP_RELEASE_SCHEMA)).toEqual(
      [
        'app',
        'bundleSha256',
        'collections',
        'contentRating',
        'manifest',
        'manifestHash',
        'releasedAt',
        'runtime',
        'source',
        'version',
      ].sort()
    );
  });

  it('🔴 an app with no content rating validates: contentRating is required and nullable', () => {
    const sets = buildEntities(CATALOG, { baseUrl: 'https://site.example' });
    const validate = compiled(sets)(APP_SCHEMA);
    const tide = (sets.get(APP_SCHEMA) ?? []).find(
      (e) => e.urn === 'urn:apps.civitai.com:app/tide-log'
    );
    const body = tide!.body as Record<string, unknown>;
    expect(body.contentRating).toBeNull();
    expect(validate(body)).toBe(true);
    // Negative controls: the schema can refuse, so the pass above is the null being accepted.
    expect(validate({ ...body, contentRating: 7 })).toBe(false);
    const { contentRating: _dropped, ...unrated } = body;
    expect(validate(unrated)).toBe(false);
  });

  it('a release that breaks its schema is refused (negative control for the claim check)', () => {
    const sets = buildEntities(CATALOG, { baseUrl: 'https://site.example' });
    const validate = compiled(sets)(APP_RELEASE_SCHEMA);
    const release = (sets.get(APP_RELEASE_SCHEMA) ?? [])[0].body as Record<string, unknown>;
    expect(validate(release)).toBe(true);
    expect(validate({ ...release, manifestHash: 'not-a-sha256' })).toBe(false);
  });

  it("the app schema tells a consumer that a document's rating is its app's", () => {
    const sets = buildEntities([], { baseUrl: 'https://site.example' });
    const app = (sets.get(JSON_SCHEMA_DIALECT) ?? []).find((e) => e.urn === APP_SCHEMA)!;
    const rating = (app.body as { properties: { contentRating: Record<string, unknown> } })
      .properties.contentRating;
    // The whole sentence: a consumer reads it, so a rewording is a deliberate change.
    expect(rating).toEqual({
      type: ['string', 'null'],
      description:
        'The content rating of the app, or null when it has none (an off-site app may have no rating). Also the rating of every document this app publishes: a document carries no rating of its own, so a consumer joins it to its app entity.',
    });
  });
});
