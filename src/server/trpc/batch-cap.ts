import { env } from '~/env/server';
import { TRPC_MAX_BATCH_SIZE } from '~/shared/constants/trpc.constants';

/**
 * The EFFECTIVE server-side tRPC batch cap.
 *
 * ── WHY THIS IS AN ENV VAR AND NOT JUST THE CONSTANT ────────────────────────────────────────
 * The compiled-in `TRPC_MAX_BATCH_SIZE` is the default, not the only way to set the cap. A cap
 * that can only be changed by editing source means every correction — including "this is
 * clipping real traffic, undo it now" — costs an image build plus a canary rollout. Reading it
 * from the environment makes the corrective action a config change on a Deployment, which is
 * the difference between a minutes-long rollback and a much longer one.
 *
 * 🔴 THE TWO DIRECTIONS ARE NOT SYMMETRIC, and only one of them is a safe rollback:
 *  - RAISING (or effectively disabling, by setting a very large value) is safe at any moment.
 *    The browser's `maxItems` is the compiled-in `TRPC_MAX_BATCH_SIZE`, so a client can never
 *    build a request wider than the constant; a server cap above it simply stops binding.
 *  - LOWERING BELOW `TRPC_MAX_BATCH_SIZE` is a tightening, not a rollback. Browsers holding the
 *    current bundle keep coalescing up to the constant, so any batch between the new value and
 *    the constant is rejected with a 400 that fails EVERY query in it at once. If the cap must
 *    genuinely go below the constant, change the constant and ship it, so both ends move
 *    together; use the env var for that only as a deliberate, monitored emergency.
 *
 * Read via a function rather than a module-scope constant so the value is resolved at the point
 * of use — the route resolves it once when it builds the adapter options, and the batch-width
 * metric resolves it per request to classify `over_limit`. Both go through THIS function, so
 * the cap tRPC enforces and the cap the metric labels against cannot drift apart.
 */
export function getTrpcMaxBatchSize(): number {
  // Read the schema-typed property DIRECTLY. `serverSchema` types this key `number`, and that
  // type is the ONLY compile-time link between the schema key and this reader. A cast here
  // (`env as { TRPC_MAX_BATCH_SIZE?: unknown }`) severs it: renaming or typo-ing the key in the
  // schema would then produce zero typecheck errors and zero test failures, and this function
  // would silently return the compiled-in default forever — i.e. the emergency lever would be
  // dead exactly when someone reached for it.
  const configured = env.TRPC_MAX_BATCH_SIZE;
  // 🔴 WHAT THE FALLBACK BELOW IS, NOW THAT THE SCHEMA FAILS SOFT.
  // `serverSchema` resolves this key with `.int().min(1).catch(TRPC_MAX_BATCH_SIZE)`, so a bad
  // env value no longer crashes boot — the schema itself yields the compiled-in constant. In a
  // process booted through `serverSchema` every value reaching here is therefore already a
  // positive integer and this branch does NOT fire; it is not a production code path and must
  // not be described as one. It is kept as a second layer for readers that do not come from
  // that parse — chiefly the test env double, which substitutes `~/env/server` wholesale and
  // can hand back anything — because the failure it prevents is silent and total: handing
  // `undefined` to `maxBatchSize` REMOVES the cap altogether, and nothing about that looks
  // wrong from the outside. Both layers fail toward "still capped".
  if (typeof configured === 'number' && Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return TRPC_MAX_BATCH_SIZE;
}
