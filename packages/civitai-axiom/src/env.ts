// Package-owned env schema. Any app that uses @civitai/axiom validates these
// vars the same way, so every app logs to Axiom with identical config.
import * as z from 'zod';

const booleanString = z.preprocess((val) => val === true || val === 'true', z.boolean());

// Every env var the Axiom logger reads is declared here so it's validated on
// deployment. App *behavior* (loggers, policy callbacks) would be injected at the
// factory instead — but those are functions, not env values, and this package has none.
const schema = z.object({
  AXIOM_TOKEN: z.string().optional(),
  AXIOM_ORG_ID: z.string().optional(),
  AXIOM_DATASTREAM: z.string().optional(),
  PODNAME: z.string().optional(),
  LOG_ERRORS_TO_STDOUT: booleanString.default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error('[@civitai/axiom] Invalid environment variables:\n' + z.prettifyError(parsed.error));
}

// Normalized, env-derived defaults. The factory accepts a Partial<AxiomConfig> to
// override any of these per call (tests, multi-instance, alternate config sources).
export const axiomEnv = {
  token: parsed.data.AXIOM_TOKEN,
  orgId: parsed.data.AXIOM_ORG_ID,
  datastream: parsed.data.AXIOM_DATASTREAM,
  podName: parsed.data.PODNAME,
  logErrorsToStdout: parsed.data.LOG_ERRORS_TO_STDOUT,
  // NODE_ENV is a universal Node convention (not Next-specific), so it's fine for a package.
  isProd: process.env.NODE_ENV === 'production',
};

export type AxiomConfig = typeof axiomEnv;
