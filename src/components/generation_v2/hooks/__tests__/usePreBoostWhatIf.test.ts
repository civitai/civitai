// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

const state = vi.hoisted(() => ({
  base: undefined as Record<string, unknown> | undefined,
  payloads: [] as { input: Record<string, unknown> | null; enabled: boolean }[],
}));

vi.mock('~/components/generation_v2/DownloadBoostConfirm', () => ({
  confirmDownloadBoost: vi.fn(),
}));
// No resource data: `isBoostable` then refuses (no base weights resolved), so only `required` can sell it.
vi.mock('~/components/generation_v2/inputs/ResourceDataProvider', () => ({
  useResourceDataContext: () => ({ getResourceData: () => undefined }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hook makes two whatIf queries, and the stub must tell them apart by payload
  trpc: {
    orchestrator: {
      whatIfFromGraph: {
        useQuery: (input: Record<string, unknown> | null, opts: { enabled: boolean }) => {
          state.payloads.push({ input, enabled: opts.enabled });
          const boostedQuery = input?.downloadPriority === 'high';
          return {
            data: boostedQuery ? { cost: { fixed: { downloadPriority: 700 } } } : state.base,
            isFetching: false,
          };
        },
      },
    },
  },
}));

import { usePreBoostWhatIf } from '~/components/generation_v2/hooks/usePreBoost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preparation = {
  resource: 'urn:air:qwen:checkpoint:civitai:1@2',
  queuePosition: 3,
  lane: 'low',
  etaSeconds: 2_400,
  boostedEtaSeconds: 240,
  resources: [{ resource: 'urn:air:qwen:checkpoint:civitai:1@2' }],
};

function render() {
  let result: ReturnType<typeof usePreBoostWhatIf> | undefined;
  const Probe = () => {
    result = usePreBoostWhatIf({ revision: 1, queryPayload: { a: 1 }, enabled: true });
    return null;
  };
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  return result!;
}

beforeEach(() => {
  state.payloads = [];
  state.base = undefined;
});

describe('usePreBoostWhatIf — boost-to-load', () => {
  it('turns a required boost on and prices it, though the ETAs alone would not sell it', () => {
    state.base = { ready: false, preparation, boostRequired: true };
    const r = render();

    expect(r.boostRequired).toBe(true);
    expect(r.preBoost).toBe(true);
    expect(r.download).toMatchObject({ boostable: true, required: true, boostFee: 700 });
    // The priced query is the boosted one, and it ran.
    expect(state.payloads.at(-1)).toEqual({
      input: { a: 1, acceptBoostRequired: true, downloadPriority: 'high' },
      enabled: true,
    });
  });

  it('leaves the same preparation off and unsold when no boost is required', () => {
    state.base = { ready: false, preparation };
    const r = render();

    expect(r.boostRequired).toBe(false);
    expect(r.preBoost).toBe(false);
    expect(r.download).toMatchObject({ boostable: false, required: false });
  });

  it('never turns on with no preparation — an empty boosted reply would price Generate at zero', () => {
    state.base = { ready: false, boostRequired: true };
    const r = render();

    expect(r.boostRequired).toBe(true);
    expect(r.preBoost).toBe(false);
    expect(r.download).toBeUndefined();
  });
});
