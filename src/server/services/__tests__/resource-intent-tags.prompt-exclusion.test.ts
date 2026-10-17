import { describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import { promptExcludedByAuditor } from '~/server/services/resource-intent-tags/prompt-exclusion';

const THROWS = 'sentinel prompt the auditor throws on';
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

  it('excludes what the generator gate blocks', () => {
    expect(promptExcludedByAuditor('9 year old girl')).toBe(true);
  });

  it('excludes what only the minor check flags (the generator gate passes it)', () => {
    expect(promptExcludedByAuditor('a little girl')).toBe(true);
  });

  it('excludes a platform POI name', () => {
    expect(promptExcludedByAuditor('a drawing of diddl-maus')).toBe(true);
  });

  it('fails closed when the auditor throws', () => {
    expect(promptExcludedByAuditor(THROWS)).toBe(true);
  });
});
