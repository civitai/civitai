import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The moderator-managed `PromptBenignPhrase` list must reach the GENERATION gate's own POI
 * decision, not just `auditPromptServer` beside it.
 *
 * `createWorkflowStepsFromGraph` computes `hasPoi` independently and, when the viewer has
 * `disablePoi` set, refuses the request outright. It read the raw prompt, so a phrase a
 * moderator had deliberately whitelisted still threw a real-person error at the creator —
 * and that refusal is invisible from the moderation side, because what it produces is a
 * generation error for one creator rather than a report in a queue.
 *
 * The first two cases are a pair on purpose. Asserting only that a whitelisted prompt does
 * not produce the POI refusal would pass for free the moment anything upstream throws first;
 * the empty-whitelist case is the positive control proving the check is reachable in this
 * fixture and does still fire.
 *
 * The mock preamble mirrors `orchestration-new.model-substitutions.test.ts` minus its redis
 * block, which `~/server/redis/client`'s canonical mock in `setup.ts` already covers — the
 * rest only keeps the heavy DB module graph inert so the module imports. The fixture carries NO model
 * and NO resources, so `validateAndEnrichResources` short-circuits on an empty ref list and
 * the POI check is the first thing that can throw.
 */

const { mockStripBenignPhrases } = vi.hoisted(() => ({ mockStripBenignPhrases: vi.fn() }));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: mockStripBenignPhrases,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import { BlocklistType } from '~/server/common/enums';
import { createWorkflowStepsFromGraph } from '~/server/services/orchestrator/orchestration-new.service';

/** A name the POI detector really matches — see `shared/utils/__tests__/benign-phrases.test.ts`. */
const POI_NAME = 'emma stone';
const PROMPT = `${POI_NAME} portrait`;
const POI_REFUSAL = /likeness of a real person/;

/** The error message this submission produced, or `''` when it produced none. */
async function submit({ prompt, disablePoi }: { prompt: string; disablePoi?: boolean }) {
  const error = await createWorkflowStepsFromGraph({
    data: (disablePoi === undefined ? { prompt } : { prompt, disablePoi }) as never,
    user: { id: 5, isModerator: false },
  }).then(
    () => undefined,
    (e: unknown) => e
  );
  if (error === undefined) return '';
  return error instanceof Error ? error.message : String(error);
}

const submitFor = (prompt: string) => submit({ prompt, disablePoi: true });

beforeEach(() => {
  // Without this the third case reads `mock.calls[0]` from the FIRST case and asserts against
  // a prompt it never sent — measured: it passed under a mutation that stripped raw text.
  // It also means a new case that forgets `mockImplementation` gets `undefined` from the strip,
  // which `includesPoi` reads as "no match" — so a new "does not refuse" case must assert the
  // call was made, the way the normalized-prompt case below does, or it passes vacuously.
  mockStripBenignPhrases.mockReset();
});

describe('generation POI gate reads the benign-stripped prompt', () => {
  it('CONTROL: refuses when the moderator has whitelisted nothing', async () => {
    mockStripBenignPhrases.mockImplementation(async (text: string) => text);

    expect(await submitFor(PROMPT)).toMatch(POI_REFUSAL);
  });

  it('does not refuse a phrase the moderator whitelisted', async () => {
    mockStripBenignPhrases.mockImplementation(async (text: string) => text.replace(POI_NAME, ' '));

    // This graph is deliberately empty, so the call may still fail further down. What must
    // not survive the whitelist is the POI refusal specifically.
    const message = await submitFor(PROMPT);

    // Carried here rather than leant on the sibling control: without it this case cannot tell
    // "the whitelist worked" from "the gate never ran", and both look like a silent pass.
    expect(mockStripBenignPhrases).toHaveBeenCalledTimes(1);
    expect(message).not.toMatch(POI_REFUSAL);
  });

  it('hands the strip the NORMALIZED prompt and the PROMPT list', async () => {
    mockStripBenignPhrases.mockImplementation(async (text: string) => text);

    const message = await submitFor('émma stone portrait');

    // Asserted BEFORE the refusal deliberately. Anything reaching step assembly dies on
    // `new TimeSpan(...)`, because the shared `@civitai/client` mock makes it a plain object —
    // so on a regression the refusal assertion fails with a constructor error that names
    // nothing. These two fail with the alphabet mismatch spelled out, so they go first.
    // The TYPE is here because nothing else can see it: swapping in `NegativeBenignPhrase`
    // type-checks, passes the source guard, and silently consults a list the moderator never
    // wrote the phrase into.
    expect(mockStripBenignPhrases).toHaveBeenCalledTimes(1);
    expect(mockStripBenignPhrases).toHaveBeenCalledWith(PROMPT, BlocklistType.PromptBenignPhrase);

    // Refuses for the same reason the CONTROL does, which is the point: normalizing is what
    // lets the detector see through the accent, so this also pins the tightening that
    // stripping the normalized copy necessarily brings with it.
    expect(message).toMatch(POI_REFUSAL);
  });

  // Named for the decision, because the next reader will be tempted to undo it: the strip is a
  // redis/DB read that REJECTS on failure, and `estimateWorkflow` (blocks.router) and
  // `whatIfFromGraph` both reach this line without auditing the prompt first. Computing the
  // refusal when nothing will read it puts that failure onto two cost-estimate paths that
  // cannot refuse anything. Hoisting the gate is what keeps it off them.
  it('does not touch the whitelist at all when disablePoi is absent', async () => {
    mockStripBenignPhrases.mockImplementation(async (text: string) => text);

    const message = await submit({ prompt: PROMPT });

    expect(mockStripBenignPhrases).not.toHaveBeenCalled();
    expect(message).not.toMatch(POI_REFUSAL);
  });

  // The case above cannot see the difference between `'disablePoi' in data` and
  // `'disablePoi' in data && data.disablePoi`, because with the key absent both are false.
  // This one can, and it is the mutation that matters: `disablePoi` is declared with
  // `.default(false)`, so wherever the field is wired up the key is PRESENT on every
  // submission. Checking only for the key would arm the gate for people who never turned the
  // setting on — refusing more creators, just as invisibly.
  it('does not arm the gate when disablePoi is present but false', async () => {
    mockStripBenignPhrases.mockImplementation(async (text: string) => text);

    const message = await submit({ prompt: PROMPT, disablePoi: false });

    expect(mockStripBenignPhrases).not.toHaveBeenCalled();
    expect(message).not.toMatch(POI_REFUSAL);
  });
});
