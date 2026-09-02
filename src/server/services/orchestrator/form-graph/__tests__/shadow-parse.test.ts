import { describe, expect, it, vi } from 'vitest';
import type * as PromMetrics from '~/server/prom/form-graph.metrics';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { inc } = vi.hoisted(() => ({ inc: vi.fn() }));
vi.mock('~/server/prom/form-graph.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof PromMetrics>()),
  formGraphShadowParseCounter: { inc },
}));

import { recordShadowComparison, runHubParse } from '../shadow-parse';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

const logToAxiom = loggingMock.logToAxiom;

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

describe('shadow-parse comparison', () => {
  it('a real parse compared against itself is a match', () => {
    inc.mockClear();
    logToAxiom.mockClear();
    const hub = runHubParse({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' }, EXT);
    if (hub.ok !== true) throw new Error('hub parse failed');
    recordShadowComparison({ success: true, data: hub.data }, hub, 'txt2img');
    expect(inc).toHaveBeenCalledWith({ outcome: 'match', workflow: 'txt2img' });
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('a differing value diverges, logging the KEY only — never the value', () => {
    inc.mockClear();
    logToAxiom.mockClear();
    const hub = runHubParse({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' }, EXT);
    if (hub.ok !== true) throw new Error('hub parse failed');
    const v1Data = { ...hub.data, prompt: 'SECRET USER PROMPT' };
    recordShadowComparison({ success: true, data: v1Data }, hub, 'txt2img');
    expect(inc).toHaveBeenCalledWith({ outcome: 'diverged', workflow: 'txt2img' });
    const logged = JSON.stringify(logToAxiom.mock.calls);
    expect(logged).toContain('"prompt"');
    expect(logged).not.toContain('SECRET USER PROMPT');
  });

  it('success/failure disagreement diverges with the losing side error keys', () => {
    inc.mockClear();
    logToAxiom.mockClear();
    recordShadowComparison(
      { success: false, errors: { prompt: { message: 'Prompt is required' } } },
      { ok: true, data: {}, computedKeys: [] },
      'txt2img'
    );
    expect(inc).toHaveBeenCalledWith({ outcome: 'diverged', workflow: 'txt2img' });
    expect(JSON.stringify(logToAxiom.mock.calls)).toContain('success-disagreement');
  });

  it('both failing with the same error keys is a match', () => {
    inc.mockClear();
    recordShadowComparison(
      { success: false, errors: { prompt: { message: 'v1 message' } } },
      { ok: false, errors: { prompt: { message: 'different port message' } } },
      'txt2img'
    );
    expect(inc).toHaveBeenCalledWith({ outcome: 'match', workflow: 'txt2img' });
  });

  it('a hub throw is the error outcome, not a crash', () => {
    inc.mockClear();
    recordShadowComparison(
      { success: true, data: {} },
      { ok: null, error: new Error('boom') },
      'txt2img'
    );
    expect(inc).toHaveBeenCalledWith({ outcome: 'error', workflow: 'txt2img' });
  });
});
