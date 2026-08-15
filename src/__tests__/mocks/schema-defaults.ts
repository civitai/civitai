import { serverSchema } from '~/env/server-schema';

/**
 * The values production would hand a consumer for env vars that are never set.
 *
 * 🔴 Asked of the schema by PARSING, not by walking `_def`. Defaults are written in at least
 * three shapes here — `zc.booleanString.default(isProd)`, `z.coerce.number().default(20)`, and
 * `z.preprocess((x) => x === 'true', z.boolean().default(false))` where the default is NESTED
 * inside the effect. A `_def` walk has to know every wrapper, and the one it misses produces a
 * plausible smaller table with nothing to say so. `parse(undefined)` is the exact question
 * production asks: preprocess runs, coercion runs, the nested default fires.
 *
 * Why it matters: production `env` is the PARSED object, so a defaulted key is never
 * `undefined` there. `REPLICATION_LAG_DELAY` is the live case — `db-lag-helpers.ts:47` does
 * `if (env.REPLICATION_LAG_DELAY <= 0) return dbRead`, which production takes and a test with
 * an absent key does not, because `undefined <= 0` is false.
 *
 * Keys with no default throw here and are skipped, which is correct: for those, absent really
 * does mean absent.
 */

type ShapeCarrier = { shape?: Record<string, { parse: (v: unknown) => unknown }> };

/** The schema is `z.object({…}).superRefine(…)`, so the object is one unwrap in — and which
 * property holds it has moved between zod majors. Try the known spellings and THROW when none
 * matches: a silently empty table would look exactly like a schema with no defaults. */
function objectShape() {
  const s = serverSchema as unknown as ShapeCarrier & {
    _def?: { schema?: ShapeCarrier; innerType?: ShapeCarrier };
    def?: { schema?: ShapeCarrier; innerType?: ShapeCarrier };
  };
  const shape =
    s.shape ??
    s._def?.schema?.shape ??
    s._def?.innerType?.shape ??
    s.def?.schema?.shape ??
    s.def?.innerType?.shape;
  if (!shape)
    throw new Error(
      'schema-defaults: could not reach serverSchema.shape — the zod wrapper shape changed. ' +
        'Fix this rather than letting the defaults table silently empty.'
    );
  return shape;
}

export function schemaDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(objectShape())) {
    try {
      const value = field.parse(undefined);
      if (value !== undefined) out[key] = value;
    } catch {
      // No default: the key is required or genuinely optional. Absent means absent.
    }
  }
  return out;
}
