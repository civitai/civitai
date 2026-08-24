// Package-owned env schema. Any app that uses @civitai/axiom validates these
// vars the same way, so every app logs to Axiom with identical config.
import * as z from 'zod';
import { buildProvisionedDatastreams, parseExtraDatastreams } from './datastreams';

const booleanString = z.preprocess((val) => val === true || val === 'true', z.boolean());

// Every env var the Axiom logger reads is declared here so it's validated on
// deployment. App *behavior* (loggers, policy callbacks) would be injected at the
// factory instead — but those are functions, not env values, and this package has none.
const schema = z.object({
  AXIOM_TOKEN: z.string().optional(),
  AXIOM_ORG_ID: z.string().optional(),
  AXIOM_DATASTREAM: z.string().optional(),
  // Comma-separated. WIDENS the provisioned-dataset allowlist in ./datastreams so a dataset created
  // in the Axiom console can be adopted by configuration, without waiting on a code release. It can
  // only add names, never remove them — see buildProvisionedDatastreams.
  AXIOM_EXTRA_DATASTREAMS: z.string().optional(),
  PODNAME: z.string().optional(),
  LOG_ERRORS_TO_STDOUT: booleanString.default(false),
});

// Normalized, env-derived defaults. The factory accepts a Partial<AxiomConfig> to
// override any of these per call (tests, multi-instance, alternate config sources).
function buildEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/axiom] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return {
    token: parsed.data.AXIOM_TOKEN,
    orgId: parsed.data.AXIOM_ORG_ID,
    datastream: parsed.data.AXIOM_DATASTREAM,
    // The set of dataset names the Axiom dual-write is allowed to target. Resolved here (not read
    // from the module const at the call site) so a test or an alternate config source can override
    // it through the factory's Partial<AxiomConfig>, exactly like every other value on this object.
    provisionedDatastreams: buildProvisionedDatastreams(
      parseExtraDatastreams(parsed.data.AXIOM_EXTRA_DATASTREAMS)
    ),
    podName: parsed.data.PODNAME,
    logErrorsToStdout: parsed.data.LOG_ERRORS_TO_STDOUT,
    // NODE_ENV is a universal Node convention (not Next-specific), so it's fine for a package.
    isProd: process.env.NODE_ENV === 'production',
  };
}

export type AxiomConfig = ReturnType<typeof buildEnv>;

// Lazy + memoized: importing this module does NOT touch process.env. Validation runs
// only when the factory calls loadAxiomEnv() — so a bare import (build, script, test)
// never throws. Parsed once, then cached.
let _env: AxiomConfig | undefined;
export function loadAxiomEnv(): AxiomConfig {
  return (_env ??= buildEnv());
}
