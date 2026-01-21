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
  /** Skip loading values from storage adapter (use only defaultValues and node defaults) */
  skipStorage?: boolean;
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
  skipStorage?: boolean;
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
  skipStorage = false,
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
    graphRef.current.init(defaultValues ?? {}, externalContext ?? ({} as ExternalCtx), {
      debug,
      skipStorage,
    });
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
  skipStorage,
  children,
}: DataGraphProviderProps<Ctx, ExternalCtx, CtxMeta>) {
  const { graph } = useDataGraph({
    graph: graphDef,
    storage,
    defaultValues,
    externalContext,
    debug,
    skipStorage,
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
): NodeSnapshot<T['Ctx'][K], K extends keyof T['Meta'] ? T['Meta'][K] : unknown> | null {
  const graph = useGraph<T>();
  return useGraphSubscription(graph, key) as NodeSnapshot<
    T['Ctx'][K],
    K extends keyof T['Meta'] ? T['Meta'][K] : unknown
  > | null;
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

// ============================================================================
// Graph-accepting Subscription Hooks
// ============================================================================

/**
 * Type helper for safe value lookup from CtxValues.
 */
type SafeValueLookup<CtxValues, K extends string> = K extends keyof CtxValues
  ? CtxValues[K]
  : CtxValues extends Record<string, infer V>
    ? V
    : unknown;

/**
 * Type helper for safe meta lookup from CtxMeta.
 */
type SafeMetaLookup<CtxMeta, K extends string> = K extends keyof CtxMeta
  ? CtxMeta[K]
  : CtxMeta extends Record<string, infer V>
    ? V
    : unknown;

/**
 * Subscribe to a single node's value using an explicit graph instance.
 * Re-renders only when this node changes.
 *
 * Use this when you have a graph instance and want strongly-typed subscriptions.
 *
 * @example
 * ```tsx
 * const graph = useGraph<GenerationGraphTypes>();
 * const snapshot = useGraphSubscription(graph, 'steps');
 * // snapshot.value and snapshot.meta are typed from the graph
 * ```
 */
export function useGraphSubscription<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>,
  CtxValues extends Record<string, unknown>,
  K extends string
>(
  graph: DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues>,
  key: K
): NodeSnapshot<SafeValueLookup<CtxValues, K>, SafeMetaLookup<CtxMeta, K>> | null {
  const subscribe = useCallback((cb: () => void) => graph.subscribe(key, cb), [graph, key]);

  const getSnapshot = useCallback(() => {
    const hasNode = graph.hasNode(key);
    if (!hasNode) {
      return null;
    }
    return graph.getSnapshot(key) as NodeSnapshot<
      SafeValueLookup<CtxValues, K>,
      SafeMetaLookup<CtxMeta, K>
    >;
  }, [graph, key]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Type helper to extract values for multiple keys from CtxValues.
 */
type MultiValues<CtxValues extends Record<string, unknown>, Keys extends readonly string[]> = {
  [K in Keys[number]]: K extends keyof CtxValues ? CtxValues[K] : unknown;
};

/**
 * Subscribe to multiple nodes' values using an explicit graph instance.
 * Re-renders when any of the subscribed nodes change.
 *
 * Use this when you need to read multiple values from a graph.
 *
 * @example
 * ```tsx
 * const graph = useGraph<GenerationGraphTypes>();
 * const values = useGraphSubscriptions(graph, ['model', 'resources', 'vae'] as const);
 * // values.model, values.resources, values.vae are typed from the graph
 * ```
 */
export function useGraphSubscriptions<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>,
  CtxValues extends Record<string, unknown>,
  Keys extends readonly string[]
>(
  graph: DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues>,
  keys: Keys
): MultiValues<CtxValues, Keys> {
  // Cache the previous snapshot to avoid creating new objects on every call
  const cacheRef = useRef<MultiValues<CtxValues, Keys> | null>(null);

  const subscribe = useCallback(
    (cb: () => void) => {
      const unsubs = keys.map((key) => graph.subscribe(key, cb));
      return () => unsubs.forEach((unsub) => unsub());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph]
  );

  const getSnapshot = useCallback(() => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const hasNode = graph.hasNode(key);
      if (hasNode) {
        const snapshot = graph.getSnapshot(key);
        result[key] = snapshot.value;
      } else {
        result[key] = undefined;
      }
    }

    // Compare with cached value - return same reference if values unchanged
    const cached = cacheRef.current;
    if (cached !== null) {
      let unchanged = true;
      for (const key of keys) {
        if (cached[key as keyof typeof cached] !== result[key]) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) {
        return cached;
      }
    }

    // Cache and return new result
    cacheRef.current = result as MultiValues<CtxValues, Keys>;
    return cacheRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
