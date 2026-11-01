import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import {
  auditPrompt,
  includesMinor,
  includesPoi,
  MAX_AUDIT_PROMPT_LENGTH,
} from '~/utils/metadata/audit';
import { promptExcludedByAuditor } from '~/server/services/resource-intent-tags/prompt-exclusion';
import { __flushPendingEmitsForTest } from '~/utils/metadata/audit-slow-log';

const THROWS = 'sentinel prompt the auditor throws on';
const logToAxiom = loggingMock.logToAxiom;
vi.mock('~/utils/metadata/audit', async (importOriginal) => {
  const real = await importOriginal<typeof Audit>();
  return {
    ...real,
    auditPrompt: (p: string, ...rest: [string?, boolean?]) => {
      if (p === THROWS) throw new Error('auditor failure');
      return real.auditPrompt(p, ...rest);
    },
  };
});

describe('promptExcludedByAuditor', () => {
  it('keeps a clean prompt', () => {
    expect(promptExcludedByAuditor('a red lighthouse on a rocky coast at dusk, watercolor')).toBe(
      false
    );
  });

  it('excludes what only the regex audit rejects', () => {
    const long = 'a quiet harbor at dusk, '.repeat(Math.ceil(MAX_AUDIT_PROMPT_LENGTH / 20));
    expect(auditPrompt(long).success).toBe(false);
    expect(includesMinor(long)).toBeFalsy();
    expect(promptExcludedByAuditor(long)).toBe(true);
  });

  it('excludes what only the minor check flags', () => {
    expect(auditPrompt('a little girl').success).toBe(true);
    expect(promptExcludedByAuditor('a little girl')).toBe(true);
  });

  it('excludes a platform POI name (the regex audit runs the POI check)', () => {
    const poi = 'a drawing of diddl-maus';
    expect(includesPoi(poi)).toBeTruthy();
    expect(includesMinor(poi)).toBeFalsy();
    expect(promptExcludedByAuditor(poi)).toBe(true);
  });

  it('fails closed when the auditor throws', () => {
    expect(promptExcludedByAuditor(THROWS)).toBe(true);
  });
});

describe('the slow-audit log never carries the prompt', () => {
  const saved = { ms: process.env.AUDIT_SLOW_LOG_MS, raw: process.env.AUDIT_SLOW_LOG_RAW };
  afterEach(() => {
    for (const [k, v] of [
      ['AUDIT_SLOW_LOG_MS', saved.ms],
      ['AUDIT_SLOW_LOG_RAW', saved.raw],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const PROMPT = 'a private lighthouse prompt nobody may read';

  // Every audit is "slow" at a 0 ms threshold, and raw capture is on: only the call decides.
  const loggedFor = async (run: () => unknown) => {
    process.env.AUDIT_SLOW_LOG_MS = '0';
    process.env.AUDIT_SLOW_LOG_RAW = 'true';
    logToAxiom.mockClear();
    run();
    await __flushPendingEmitsForTest();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    return logToAxiom.mock.calls[0] as unknown[];
  };

  it('promptExcludedByAuditor logs timings and shape only', async () => {
    const [payload] = await loggedFor(() => promptExcludedByAuditor(PROMPT));
    expect(payload).toMatchObject({ name: 'audit-prompt-slow', promptLength: PROMPT.length });
    expect(JSON.stringify(payload)).not.toContain('lighthouse');
    expect(payload).not.toHaveProperty('promptHash');
  });

  it('control: a plain auditPrompt of the same text, in the same env, logs it', async () => {
    const [payload] = await loggedFor(() => auditPrompt(PROMPT));
    expect(payload).toMatchObject({ rawPrompt: PROMPT });
  });
});
