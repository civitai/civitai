import { describe, expect, it, vi } from 'vitest';

// Drive the embedding branch of applyResources deterministically. The vuln under
// test is the triggerWord→RegExp construction inside that branch, not AIR parsing;
// the real Air.parse needs a live-format URN, so we force the type here. The
// functional assertions below only pass if the branch actually ran.
vi.mock('~/utils/string-helpers', async (importActual) => {
  const actual = await importActual<typeof import('~/utils/string-helpers')>();
  return {
    ...actual,
    parseAIR: () => ({ type: 'embedding', source: 'civitai', model: 1234, version: 5678 }),
  };
});

import { applyResources } from '~/server/services/orchestrator/comfy/comfy.utils';

const EMBED_AIR = 'urn:air:sd1:embedding:civitai:1234@5678';

const node = (text: string) => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflow: { p: { class_type: 'CLIPTextEncode', inputs: { text } } } as any,
});

describe('applyResources — embedding trigger-word regex safety', () => {
  it('does NOT ReDoS-freeze on a regex-metachar triggerWord (was ~14s pre-fix)', () => {
    // Unescaped, "(x+x+)+y" compiled to \b(x+x+)+y\b backtracks exponentially on
    // an x-run. Escaped, it is a literal — no backtracking. The literal prefix
    // also passes the `.includes` gate so the vulnerable branch IS entered.
    const triggerWord = '(x+x+)+y';
    const { workflow } = node(`${triggerWord} ${'x'.repeat(40)}`);
    const t0 = Date.now();
    applyResources(workflow, [{ air: EMBED_AIR, triggerWord }]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('still replaces a normal literal triggerWord with the embedding reference', () => {
    const { workflow } = node('a myembed b');
    applyResources(workflow, [{ air: EMBED_AIR, triggerWord: 'myembed' }]);
    expect(workflow.p.inputs.text).toBe(`a embedding:${EMBED_AIR} b`);
  });

  it('treats regex metacharacters in the triggerWord LITERALLY (no injection)', () => {
    // "a.b" must match only the literal "a.b", never "axb".
    const { workflow } = node('a.b and axb');
    applyResources(workflow, [{ air: EMBED_AIR, triggerWord: 'a.b' }]);
    expect(workflow.p.inputs.text).toBe(`embedding:${EMBED_AIR} and axb`);
  });
});
