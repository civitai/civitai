import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { DataGraph, InferDataGraph, NodeSnapshot, StorageAdapter } from '../data-graph';

// ============================================================================
// Types
// ============================================================================

export interface DataGraphProviderProps<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>
> {
  /** The DataGraph definition (will be cloned internally) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: DataGraph<any, ExternalCtx, any>;
  /** Optional storage adapter for persistence */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storage?: StorageAdapter<any>;
  /** Default/initial values to pass to graph.init() */
  defaultValues?: Partial<Ctx>;
  /** External context to pass to graph.init() */
  externalContext?: ExternalCtx;
  /** Enable debug logging */
  debug?: boolean;
  /** Children */
  children: ReactNode;
}

// ============================================================================
// Context
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DataGraphContext = createContext<DataGraph<any, any, any, any> | null>(null);

// ============================================================================
// useDataGraph Hook
// ============================================================================

interface UseDataGraphOptions<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>
> {
  graph: DataGraph<Ctx, ExternalCtx, CtxMeta>;
  storage?: StorageAdapter<Ctx>;
  defaultValues?: Partial<Ctx>;
  externalContext?: ExternalCtx;
  debug?: boolean;
}

function useDataGraph<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>
>({
  graph: graphDef,
  storage,
  defaultValues,
  externalContext,
  debug = false,
}: UseDataGraphOptions<Ctx, ExternalCtx, CtxMeta>): {
  graph: DataGraph<Ctx, ExternalCtx, CtxMeta>;
} {
  // Track the graph definition's createdAt to detect HMR updates
  const graphDefCreatedAtRef = useRef(graphDef.createdAt);
  const graphRef = useRef<DataGraph<Ctx, ExternalCtx, CtxMeta> | null>(null);
  const initializedRef = useRef(false);

  // Detect if graph definition changed (HMR)
  const graphDefChanged = graphDefCreatedAtRef.current !== graphDef.createdAt;
  if (graphDefChanged) {
    graphDefCreatedAtRef.current = graphDef.createdAt;
    // Force re-creation on next access
    graphRef.current = null;
    initializedRef.current = false;
  }

  // Clone and initialize on first access (or after HMR)
  if (!graphRef.current) {
    const cloned = graphDef.clone();

    // Attach storage if provided
    if (storage) {
      cloned.useStorage(storage);
    }

    graphRef.current = cloned;
  }

  // Initialize once (handles React Strict Mode double-mount)
  if (!initializedRef.current) {
    graphRef.current.init(defaultValues ?? {}, externalContext ?? ({} as ExternalCtx), { debug });
    initializedRef.current = true;
  }

  // Update external context when it changes
  const extRef = useRef(externalContext);
  useEffect(() => {
    if (graphRef.current && externalContext && extRef.current !== externalContext) {
      extRef.current = externalContext;
      graphRef.current.setExt(externalContext);
    }
  }, [externalContext]);

  return { graph: graphRef.current };
}

// ============================================================================
// Provider Component
// ============================================================================

/**
 * Provides a DataGraph instance to descendant components via context.
 */
export function DataGraphProvider<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>
>({
  graph: graphDef,
  storage,
  defaultValues,
  externalContext,
  debug,
  children,
}: DataGraphProviderProps<Ctx, ExternalCtx, CtxMeta>) {
  const { graph } = useDataGraph({
    graph: graphDef,
    storage,
    defaultValues,
    externalContext,
    debug,
  });

  return <DataGraphContext.Provider value={graph}>{children}</DataGraphContext.Provider>;
}

// ============================================================================
// Consumer Hooks
// ============================================================================

/**
 * Default type for useGraph when no type parameter is provided.
 * Use InferDataGraph<typeof myGraph> for strongly-typed graphs.
 */
type DefaultGraphTypes = {
  Ctx: Record<string, unknown>;
  ExternalCtx: Record<string, unknown>;
  Meta: Record<string, unknown>;
  Values: Record<string, unknown>;
};

/** Re-export InferDataGraph for convenience */
export type { InferDataGraph };

/**
 * Get the graph instance (stable - never causes re-renders).
 * Use this to call graph.set(), graph.reset(), graph.validate(), etc.
 *
 * @example
 * ```tsx
 * // Using InferDataGraph for full type inference:
 * type MyGraph = InferDataGraph<typeof myGraphDef>;
 * const graph = useGraph<MyGraph>();
 * graph.set({ steps: 25 }); // typed!
 * ```
 */
export function useGraph<T extends DefaultGraphTypes = DefaultGraphTypes>(): DataGraph<
  T['Ctx'],
  T['ExternalCtx'],
  T['Meta'],
  T['Values']
> {
  const graph = useContext(DataGraphContext);
  if (!graph) {
    throw new Error('useGraph must be used within a DataGraphProvider');
  }
  return graph;
}

/**
 * Subscribe to a single node's value. Re-renders only when this node changes.
 *
 * @example
 * ```tsx
 * type MyGraph = InferDataGraph<typeof myGraphDef>;
 * const snapshot = useGraphValue<MyGraph, 'steps'>('steps');
 * // snapshot.value is typed as number
 * // snapshot.meta is typed as { min: number; max: number }
 * ```
 */
export function useGraphValue<T extends DefaultGraphTypes, K extends keyof T['Ctx'] & string>(
  key: K
): NodeSnapshot<T['Ctx'][K], K extends keyof T['Meta'] ? T['Meta'][K] : unknown> {
  const graph = useGraph<T>();

  const subscribe = useCallback((cb: () => void) => graph.subscribe(key, cb), [graph, key]);
  const getSnapshot = useCallback(() => graph.getSnapshot(key), [graph, key]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to all graph values. Re-renders on any node change.
 * Use sparingly - prefer useGraphValue for individual nodes.
 *
 * @example
 * ```tsx
 * type MyGraph = InferDataGraph<typeof myGraphDef>;
 * const values = useGraphValues<MyGraph>();
 * // values is typed as MyGraph['Ctx']
 * ```
 */
export function useGraphValues<T extends DefaultGraphTypes>(): T['Ctx'] {
  const graph = useGraph<T>();

  const subscribe = useCallback((cb: () => void) => graph.subscribe(cb), [graph]);
  const getSnapshot = useCallback(() => graph.getSnapshot(), [graph]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
