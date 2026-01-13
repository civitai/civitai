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
 * Props for the Controller component.
 * Types are inferred directly from the DataGraph instance.
 *
 * Note: For complex nested discriminators, we use `string` as the key constraint
 * to avoid TypeScript inference limits. The meta types are still strongly typed
 * via the CtxMeta intersection type. CtxValues is an intersection of all possible
 * value types from discriminator branches, providing reliable type lookups.
 */
export interface ControllerProps<
  Ctx extends Record<string, unknown>,
  ExternalCtx extends Record<string, unknown>,
  CtxMeta extends Record<string, unknown>,
  CtxValues extends Record<string, unknown>,
  K extends string
> {
  /** The graph instance */
  graph: DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues>;
  /** The node key to control */
  name: K;
  /** Render function that receives the node's state and onChange handler */
  render: (
    props: ControllerRenderProps<
      K extends keyof CtxValues ? CtxValues[K] : unknown,
      K extends keyof CtxMeta ? CtxMeta[K] : unknown
    >
  ) => ReactElement | null;
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
  K extends string
>({ graph, name, render }: ControllerProps<Ctx, ExternalCtx, CtxMeta, CtxValues, K>): ReactElement | null {
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
  // Use CtxValues for the type since it's an intersection of all possible value types
  type ValueType = K extends keyof CtxValues ? CtxValues[K] : unknown;
  const onChange = useCallback(
    (newValue: ValueType) => {
      graph.set({ [name]: newValue } as unknown as Partial<Ctx>);
    },
    [graph, name]
  );

  // If node doesn't exist (inactive discriminator branch), return null
  if (snapshot === null) {
    return null;
  }

  // Call render with strongly-typed props
  type MetaType = K extends keyof CtxMeta ? CtxMeta[K] : unknown;
  return render({
    value: snapshot.value as ValueType,
    meta: snapshot.meta as MetaType,
    error: snapshot.error,
    onChange,
    isComputed: snapshot.isComputed,
  });
}
