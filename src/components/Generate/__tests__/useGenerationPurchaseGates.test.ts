// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type { PurchaseGate } from '~/components/Generate/paid-access-gate';
import { useGenerationPurchaseGates } from '~/components/Generate/useGenerationPurchaseGates';

const TRIAL = { generation: { price: 200, trialLimit: 5 } };

const paid = (id: number, modelName: string) => ({
  id,
  name: `v${id}`,
  paidAccess: { endsAt: null, terms: TRIAL },
  isOwnedByUser: false,
  model: { id: id * 10, name: modelName },
});

const state = vi.hoisted(() => ({
  provided: [] as unknown[],
  queriedIds: [] as number[][],
}));

vi.mock('~/components/generation_v2/inputs/ResourceDataProvider', () => ({
  useResourceDataContext: () => ({ resources: state.provided }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    common: {
      getEntityAccess: {
        useQuery: ({ entityId }: { entityId: number[] }) => {
          state.queriedIds.push(entityId);
          return { data: [], isLoading: false };
        },
      },
    },
  },
}));

function gatesFor(selectedIds: number[]): PurchaseGate[] {
  let gates: PurchaseGate[] = [];
  function Probe() {
    gates = useGenerationPurchaseGates(selectedIds).gates;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  return gates;
}

describe('useGenerationPurchaseGates', () => {
  beforeEach(() => {
    state.queriedIds = [];
    // The provider also holds every ecosystem's prefetched default checkpoint, selected or not.
    state.provided = [paid(1, 'Selected LoRA'), paid(2, 'Other ecosystem default')];
  });

  it('gates only the resources the form selected', () => {
    const gates = gatesFor([1]);

    expect(gates.map((gate) => gate.modelName)).toEqual(['Selected LoRA']);
    expect(state.queriedIds.at(-1)).toEqual([1]);
  });

  it('gates nothing when no paid resource is selected', () => {
    expect(gatesFor([99])).toEqual([]);
  });
});
