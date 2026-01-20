import { useCallback, useSyncExternalStore, type ReactElement } from 'react';
import type { DataGraph, NodeError } from '../data-graph';

// ============================================================================
// Types
// ============================================================================

/**
 * Props passed to the render function of a Controller.
 * All types are strongly inferred from the graph's CtxValues and CtxMeta types.
 */
export interface ControllerRenderProps<Value, Meta> {
  /** Current value of the node */
  value: Value;
  /** Dynamic meta for this node (context-dependent props like min/max/options) */
  meta: Meta;
  /** Validation error for this node (if any) */
  error: NodeError | undefined;
  /** Update the value - calls graph.set({ [name]: newValue }) */
  onChange: (newValue: Value) => void;
  /** Whether this is a computed node (read-only) */
  isComputed: boolean;
}

/**
 * Lookup type that always returns a value (never `never`).
 * Uses intersection with string to ensure K is treated as a valid key.
 */
type SafeValueLookup<CtxValues, K extends string> = K extends keyof CtxValues
  ? CtxValues[K]
  : CtxValues extends Record<string, infer V>
  ? V
  : unknown;

type SafeMetaLookup<CtxMeta, K extends string> = K extends keyof CtxMeta
  ? CtxMeta[K]
  : CtxMeta extends Record<string, infer V>
  ? V
  : unknown;

/**
 * Props for the Controller component.
 * Types are inferred directly from the DataGraph instance.
 *
 * Note: For complex nested discriminators, we use `string` as the key constraint
 * to avoid TypeScript inference limits. The meta types are still strongly typed
 * via the CtxMeta intersection type. CtxValues is an intersection of all possible
 * value types from discriminator branches, providing reliable type lookups.
 *
 * When type inference fails due to graph complexity, use explicit type parameters:
 * <Controller<Value, Meta> graph={graph} name="key" render={...} />
 */
export interface ControllerProps<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>,
  CtxValues extends Record<string, unknown>,
  K extends string,
  // Explicit type overrides for when inference fails
  ValueOverride = SafeValueLookup<CtxValues, K>,
  MetaOverride = SafeMetaLookup<CtxMeta, K>
> {
  /** The graph instance */
  graph: DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues>;
  /** The node key to control */
  name: K;
  /** Render function that receives the node's state and onChange handler */
  render: (props: ControllerRenderProps<ValueOverride, MetaOverride>) => ReactElement | null;
}

// ============================================================================
// Controller Component
// ============================================================================

/**
 * Controller component for rendering graph nodes with strongly-typed meta.
 *
 * Similar to react-hook-form's Controller, this component:
 * - Subscribes to a specific node in the graph
 * - Passes strongly-typed value, meta, error, and onChange to the render function
 * - Automatically returns null if the node doesn't exist (inactive discriminator branch)
 *
 * Types are automatically inferred from the graph instance:
 * - value is typed based on the node's output schema
 * - meta is typed based on the node's meta definition
 *
 * @example
 * ```tsx
 * // Types are inferred from the graph - no explicit type parameters needed
 * <Controller
 *   graph={graph}
 *   name="steps"
 *   render={({ value, meta, onChange }) => (
 *     <SliderInput
 *       label="Steps"
 *       value={value}        // typed as number
 *       onChange={onChange}
 *       min={meta.min}       // typed from meta definition
 *       max={meta.max}
 *       step={meta.step}
 *     />
 *   )}
 * />
 * ```
 */
export function Controller<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>,
  CtxValues extends Record<string, unknown>,
  K extends string,
  ValueOverride = SafeValueLookup<CtxValues, K>,
  MetaOverride = SafeMetaLookup<CtxMeta, K>
>({
  graph,
  name,
  render,
}: ControllerProps<
  Ctx,
  ExternalCtx,
  CtxMeta,
  CtxValues,
  K,
  ValueOverride,
  MetaOverride
>): ReactElement | null {
  // Subscribe to this specific node
  const subscribe = useCallback(
    (cb: () => void) => graph.subscribe(name as string, cb),
    [graph, name]
  );

  const getSnapshot = useCallback(() => {
    // Check if node exists in current context
    const hasNode = graph.hasNode(name);
    if (!hasNode) {
      return null;
    }
    return graph.getSnapshot(name as string);
  }, [graph, name]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Create onChange handler - must be called before any early returns to maintain hook order
  const onChange = useCallback(
    (newValue: ValueOverride) => {
      graph.set({ [name]: newValue } as unknown as Partial<Ctx>);
    },
    [graph, name]
  );

  // If node doesn't exist (inactive discriminator branch), return null
  if (snapshot === null) {
    return null;
  }

  // Call render with typed props (uses override types when inference fails)
  return render({
    value: snapshot.value as ValueOverride,
    meta: snapshot.meta as MetaOverride,
    error: snapshot.error,
    onChange,
    isComputed: snapshot.isComputed,
  });
}

/**
 * Loose Controller for complex graphs where type inference fails.
 * Use this when the graph has too many discriminator branches and TypeScript
 * gives up on type inference (values become 'unknown').
 *
 * This provides the same runtime behavior as Controller, but with relaxed types.
 * You can add inline type assertions in the render function as needed.
 *
 * @example
 * ```tsx
 * <LooseController
 *   graph={graph}
 *   name="steps"
 *   render={({ value, meta, onChange }) => (
 *     <SliderInput
 *       value={value as number}  // Add type assertion
 *       onChange={onChange}
 *       min={(meta as { min: number }).min}
 *     />
 *   )}
 * />
 * ```
 */
export function LooseController<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  G extends DataGraph<any, any, any, any>
>({
  graph,
  name,
  render,
}: {
  graph: G;
  name: string;
  render: (props: ControllerRenderProps<unknown, unknown>) => ReactElement | null;
}): ReactElement | null {
  // Subscribe to this specific node
  const subscribe = useCallback((cb: () => void) => graph.subscribe(name, cb), [graph, name]);

  const getSnapshot = useCallback(() => {
    const hasNode = graph.hasNode(name);
    if (!hasNode) {
      return null;
    }
    return graph.getSnapshot(name);
  }, [graph, name]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const onChange = useCallback(
    (newValue: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      graph.set({ [name]: newValue } as any);
    },
    [graph, name]
  );

  if (snapshot === null) {
    return null;
  }

  return render({
    value: snapshot.value,
    meta: snapshot.meta,
    error: snapshot.error,
    onChange,
    isComputed: snapshot.isComputed,
  });
}
