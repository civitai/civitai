/**
 * WhatIf (cost estimation) for the form-graph lane — the counterpart of
 * generation_v2's `WhatIfProvider` + `useWhatIfFromGraph`, on the form-graph
 * store. Prompt changes do NOT trigger re-fetches (per-key fingerprints
 * project each value to the slice that affects cost), and content fields are
 * validated with placeholders so an empty prompt doesn't block estimation.
 */

import { isEqual, omit } from 'lodash-es';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useImagesUploadingOrVerifying } from '~/components/Generation/Input/SourceImageUploadMultiple';
import { useResourceDataContext } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { filterSnapshotForSubmit } from '~/components/generation_v2/utils';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import { applyWhatIfFingerprints } from '~/shared/data-graph/generation/whatif-fingerprints';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { reconcileSelectors } from '~/shared/form-graph/generation/reconcile';
import { defaultWorkflowCost } from '~/shared/orchestrator/workflow-data';
import { trpc } from '~/utils/trpc';
import type { GenerationStore } from './store';

/** The first blocking message, in field declaration order. */
export function getMissingFieldMessage(
  errors: Record<string, { message?: string }> | null
): string | null {
  if (!errors) return null;
  for (const error of Object.values(errors)) {
    if (error.message) return error.message;
  }
  return null;
}

/** Fields whose content never affects cost — placeholdered for estimation. */
const CONTENT_PLACEHOLDERS = { prompt: 'cost estimation', musicDescription: 'cost estimation' };
const CONTENT_KEYS = ['prompt', 'negativePrompt', 'musicDescription', 'lyrics', 'styleReferences'];

export function useWhatIfFromStore({
  store,
  ext,
  enabled = true,
}: {
  store: GenerationStore;
  ext: GenerationCtx;
  enabled?: boolean;
}) {
  const currentUser = useCurrentUser();
  const { isLoading: resourcesLoading } = useResourceDataContext();
  const imagesPending = useImagesUploadingOrVerifying();

  // Re-render only when a cost-relevant slice of state changes
  const [revision, incrementRevision] = useReducer((r: number) => r + 1, 0);
  const prevRelevantRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    const buildRelevant = () =>
      omit(
        applyWhatIfFingerprints(store.getSnapshot().state as Record<string, unknown>),
        store.getComputedKeys()
      );
    prevRelevantRef.current = buildRelevant();
    return store.subscribe(() => {
      const relevant = buildRelevant();
      if (!isEqual(relevant, prevRelevantRef.current)) {
        prevRelevantRef.current = relevant;
        incrementRevision();
      }
    });
  }, [store]);

  // The estimation parse: current state with content placeholders filled, run
  // back through the parse boundary (reconcile + hub) — the same projection a
  // submit makes, minus the content the user hasn't written yet.
  const parseResult = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    revision;
    const state = store.getSnapshot().state as Record<string, unknown>;
    const raw: Record<string, unknown> = { ...state };
    for (const [key, placeholder] of Object.entries(CONTENT_PLACEHOLDERS)) {
      if (!raw[key]) raw[key] = placeholder;
    }
    return generationHub.parse(reconcileSelectors(raw).raw, ext);
  }, [revision, store, ext]);

  const canEstimateCost = parseResult.success;

  const queryPayload = useMemo(() => {
    if (!parseResult.success) return null;
    const outputSnapshot = omit(parseResult.data as Record<string, unknown>, CONTENT_KEYS);
    return filterSnapshotForSubmit(outputSnapshot, { computedKeys: store.getComputedKeys() });
  }, [parseResult, store]);

  const workflow = (store.getSnapshot().state as { workflow?: string }).workflow;
  const isNoSubmit = workflowConfigByKey.get(workflow ?? '')?.noSubmit === true;

  const queryResult = trpc.orchestrator.whatIfFromGraph.useQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryPayload as any,
    {
      enabled:
        enabled &&
        !isNoSubmit &&
        !!currentUser &&
        !!queryPayload &&
        !resourcesLoading &&
        !imagesPending,
    }
  );

  const data = useMemo(
    () =>
      queryResult.data ?? {
        cost: defaultWorkflowCost,
        ready: false,
        allowMatureContent: false,
        transactions: undefined,
      },
    [queryResult.data]
  );

  const validationErrors = parseResult.success ? null : parseResult.errors;

  return {
    ...queryResult,
    data,
    isLoading: queryResult.isFetching || imagesPending,
    canEstimateCost,
    validationErrors,
  };
}

type WhatIfContextValue = ReturnType<typeof useWhatIfFromStore>;

const WhatIfContext = createContext<WhatIfContextValue | null>(null);

export function useWhatIfContext() {
  const context = useContext(WhatIfContext);
  if (!context) throw new Error('useWhatIfContext must be used within a WhatIfProvider');
  return context;
}

export function WhatIfProvider({
  store,
  ext,
  enabled = true,
  children,
}: {
  store: GenerationStore;
  ext: GenerationCtx;
  enabled?: boolean;
  children: ReactNode;
}) {
  const whatIf = useWhatIfFromStore({ store, ext, enabled });
  return <WhatIfContext.Provider value={whatIf}>{children}</WhatIfContext.Provider>;
}
