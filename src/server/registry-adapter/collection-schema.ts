/**
 * Collection schemas as registry schema entities: one JSON Schema 2020-12 document per
 * (app, collection, major), recomputed from the approved manifest history on every read so the
 * adapter keeps no state for them.
 *
 * What a major IS, and the steps between majors, are not decided here: they come from the shared
 * module `services/apps/storage-schema-majors.ts`, which the document store uses too, so the
 * store and the registry agree on what "major 3" is. This file turns those majors into registry
 * entities.
 *
 * A schema, once published, changes only by what its own major allows. A mint adds the new major
 * (with `x-migrateFrom`) and changes an older one only by the 2020-12 annotation
 * `deprecated: true`, which a major allows in place.
 */
import type {
  AppStorageCollectionSchema,
  AppStorageFeature,
} from '~/shared/constants/block-storage.constants';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  isCollectionRegistryPublic,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';
import { registryUrn } from '~/server/registry-adapter/urn';
import type { MajorDerivation, MigrateStep } from '~/server/services/apps/storage-schema-majors';

// The majors themselves live in the shared module; re-exported for the adapter's own importers.
export {
  HEAD_STEP,
  deriveCollectionMajors,
  isAdditive,
  migrateSteps,
} from '~/server/services/apps/storage-schema-majors';
export type {
  CollectionMajors,
  MajorDerivation,
  ManifestStep,
  MigrateStep,
} from '~/server/services/apps/storage-schema-majors';

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Annotation on a major `@v{n+1}` naming `@v{n}` and the steps that turn a `@v{n}` body into one
 * of its own. PROVISIONAL: it is `civitai/civitai-registry` proposals/migrations.md (issue #2),
 * not yet accepted into the spec, so its name or shape may still change; settle it before a
 * registry acts on it. Validators ignore it (an unknown keyword is an annotation in 2020-12).
 */
export const MIGRATE_FROM_ANNOTATION = 'x-migrateFrom';

export type MigrateFrom = { schema: string; steps: MigrateStep[] };

/**
 * The registry schema document for one major of a collection. A declared schema never holds an
 * `x-` key (the store accepts only its own keyword list), so the lineage is only ever this
 * adapter's.
 */
export function synthesizeCollectionSchema(args: {
  urn: string;
  declared: AppStorageCollectionSchema | undefined;
  migrateFrom?: MigrateFrom;
  /** A newer major exists: marked with the 2020-12 `deprecated` annotation. */
  deprecated?: boolean;
}): Record<string, unknown> {
  return {
    ...(args.declared ?? {}),
    $schema: JSON_SCHEMA_DIALECT,
    $id: args.urn,
    ...(args.deprecated ? { deprecated: true } : {}),
    ...(args.migrateFrom ? { [MIGRATE_FROM_ANNOTATION]: args.migrateFrom } : {}),
  };
}

/**
 * The collections an enforced manifest publishes to registries: opted in (`registry: "public"`,
 * shared only) AND the platform's live `registryExport` switch on. The one rule for schema
 * entities, a release's `collections` and document streams: a collection that is not exported
 * publishes nothing, not even its schema. The manifest's SHAPE is read with every feature on (an
 * approved manifest stays parseable when a feature it uses is switched off); whether the feature
 * may act is `features` alone.
 */
export function exportedCollections(
  manifest: unknown,
  features: Readonly<Record<AppStorageFeature, boolean>>
): Set<string> {
  if (!features.registryExport) return new Set();
  return new Set(
    [...parseManifestStorage(manifest, APP_STORAGE_ALL_FEATURES_ON).collections]
      .filter(([, c]) => isCollectionRegistryPublic(c))
      .map(([name]) => name)
  );
}

/**
 * Every schema entity body of one app: each major of each collection its newest manifest declares,
 * or, with `only`, of those collections alone.
 */
export function collectionSchemaDocuments(
  slug: string,
  derivation: MajorDerivation,
  only?: ReadonlySet<string>
): Array<{ urn: string; body: Record<string, unknown> }> {
  const out: Array<{ urn: string; body: Record<string, unknown> }> = [];
  for (const [collection, state] of derivation.collections) {
    if (!state.declared || (only && !only.has(collection))) continue;
    state.majors.forEach((declared, i) => {
      const major = i + 1;
      const urn = registryUrn({ kind: 'collection-schema', slug, collection, major });
      const steps = state.migrations[i];
      const migrateFrom =
        major > 1 && steps
          ? {
              schema: registryUrn({
                kind: 'collection-schema',
                slug,
                collection,
                major: major - 1,
              }),
              steps,
            }
          : undefined;
      const deprecated = major < state.majors.length;
      out.push({
        urn,
        body: synthesizeCollectionSchema({ urn, declared, migrateFrom, deprecated }),
      });
    });
  }
  return out;
}
