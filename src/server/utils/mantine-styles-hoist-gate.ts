import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { createCachedFlagGate } from '~/server/utils/otel-withspan-gate';

/**
 * The globalThis key the patched `@mantine/core` `useStyles` reads its gate from
 * (patches/@mantine__core@7.17.8.patch, both `esm/` and `cjs/`). A registered symbol rather than a
 * module export: a node_modules patch cannot import app code, and the server build compiles
 * Mantine into several runtime modules, each with its own copy, which all share one globalThis.
 *
 * 🔴 The string must match the one in the patch byte for byte. If it does not, the gate is never
 * read and the switch does nothing. `src/tests/build/mantine-use-styles-hoist.test.ts` pins both.
 */
export const MANTINE_USE_STYLES_HOIST_GATE_KEY = 'civitai.mantine.useStylesHoist';

type GateHolder = { [key: symbol]: (() => boolean) | undefined };

/** Install (or, with `undefined`, remove) the gate the patched `useStyles` reads per instance. */
export function setMantineUseStylesHoistGate(gate: (() => boolean) | undefined): void {
  const holder = globalThis as unknown as GateHolder;
  const key = Symbol.for(MANTINE_USE_STYLES_HOIST_GATE_KEY);
  if (gate) holder[key] = gate;
  else delete holder[key];
}

/**
 * Arm the hoist behind the `ssr-mantine-usestyles-hoist` Flipt flag. Called once at boot from
 * src/instrumentation.node.ts, so it only ever runs on the server; the browser never has a gate
 * and runs the original code, which produces the same markup. The flag is read at most once per
 * refresh window, and `null` (unknown flag, Flipt not ready) or a throwing read means off.
 */
export function registerMantineUseStylesHoistGate(): void {
  setMantineUseStylesHoistGate(
    createCachedFlagGate(() => isFliptSync(FLIPT_FEATURE_FLAGS.SSR_MANTINE_USESTYLES_HOIST))
  );
}
