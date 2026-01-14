import isEqual from 'lodash/isEqual.js';

// ============================================================================
// Types
// ============================================================================

type AnyZodSchema = { _zod: { output: unknown } };
type InferOutput<T extends AnyZodSchema> = T['_zod']['output'];

/** Utility type that flattens nested intersections for better IDE display */
type Prettify<T> = { [K in keyof T]: T[K] } & NonNullable<unknown>;

/** Merge that distributes over unions in A - preserves discriminated unions and prettifies */
type MergeDistributive<A, B> = A extends unknown ? Prettify<Omit<A, keyof B> & B> : never;

/** Empty object type that works correctly with Merge (unlike Record<string, never>) */
type EmptyObject = Record<never, never>;

type NodeCallback = () => void;

type EffectFn<Ctx, ExternalCtx> = (
  ctx: Ctx,
  ext: ExternalCtx,
  set: <K extends keyof Ctx>(key: K, value: Ctx[K]) => void
) => void;

/** Options for reset method */
export interface ResetOptions<Ctx> {
  /** Keys to preserve (won't be reset) */
  exclude?: (keyof Ctx & string)[];
}

/** Actions available to node factories for updating the graph */
interface GraphActions<Ctx> {
  /** Update one or more node values */
  set: (values: Partial<Ctx>) => Ctx;
  /** Reset all nodes to their default values */
  reset: (options?: ResetOptions<Ctx>) => Ctx;
}

/** Validation error from Zod */
interface NodeError {
  message: string;
  code: string;
  path?: (string | number)[];
}

/** Snapshot of a single node's state - Meta is strongly typed per-node */
export interface NodeSnapshot<T = unknown, Meta = unknown> {
  value: T;
  meta: Meta | undefined;
  error: NodeError | undefined;
  isComputed: boolean;
  /** Unique key that changes when meta changes - useful for React keys */
  metaKey: number | undefined;
}

/** Node entry info returned in validation result */
export type NodeEntry =
  | { kind: 'node'; key: string; deps: readonly string[] }
  | { kind: 'computed'; key: string; deps: readonly string[] };

/** Result of validation - similar to Zod's safeParse */
export type ValidationResult<T> =
  | { success: true; data: T; nodes: Record<string, NodeEntry> }
  | { success: false; errors: Record<string, NodeError> };

// ============================================================================
// Storage Adapter Types
// ============================================================================

/**
 * Storage adapter interface for persisting graph state.
 */
export interface StorageAdapter<Ctx extends Record<string, unknown> = Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attach(graph: DataGraph<Ctx, any, any>): void;
  onSet(values: Partial<Ctx>, ctx: Ctx): void;
  getValues(): Partial<Ctx>;
  onBeforeEvaluate?(): void;
  onInit(): void;
}

// ============================================================================
// Discriminator Types
// ============================================================================

// Extract the Ctx type from a DataGraph or a lazy factory that returns one
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferGraphContext<G> = G extends DataGraph<infer Ctx, any, any, any>
  ? Ctx
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
  G extends (ctx: any, ext: any) => DataGraph<infer Ctx, any, any, any>
  ? Ctx
  : never;

// Extract the CtxMeta type from a DataGraph
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferGraphMeta<G> = G extends DataGraph<any, any, infer CtxMeta, any>
  ? CtxMeta
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
  G extends (ctx: any, ext: any) => DataGraph<any, any, infer CtxMeta, any>
  ? CtxMeta
  : never;

// Extract the CtxValues type from a DataGraph (4th type parameter)
// This is the intersection of all possible value types, including nested discriminators
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferGraphValues<G> = G extends DataGraph<any, any, any, infer CtxValues>
  ? CtxValues
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
  G extends (ctx: any, ext: any) => DataGraph<any, any, any, infer CtxValues>
  ? CtxValues
  : never;

// Branch definition - a graph or a lazy factory that creates one
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BranchGraph = DataGraph<any, any, any, any>;

// Lazy branch factory - receives parent context and external context
type LazyBranchFactory<Ctx, ExternalCtx> = (ctx: Ctx, ext: ExternalCtx) => BranchGraph;

// Branch can be either a graph instance or a lazy factory
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BranchDefinition<Ctx = any, ExternalCtx = any> =
  | BranchGraph
  | LazyBranchFactory<Ctx, ExternalCtx>;

// Branches record - values can be graphs or lazy factories
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BranchesRecord<Ctx = any, ExternalCtx = any> = Record<
  string,
  BranchDefinition<Ctx, ExternalCtx>
>;

// Helper: Distributive Omit that preserves discriminated unions
type OmitDistributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// Helper: Get the "own" context from a branch (what the subgraph adds, excluding parent keys)
// The subgraph's InferGraphContext already includes its nested discriminated union
// We just strip the parent keys and add the discriminator literal
type BranchShape<
  ParentCtx extends Record<string, unknown>,
  DiscKey extends string,
  BranchName extends string,
  BranchGraph
> = Prettify<
  { [K in DiscKey]: BranchName } & OmitDistributive<InferGraphContext<BranchGraph>, keyof ParentCtx>
>;

// Build the discriminated union for Ctx
// Bottom-up approach: each branch produces a single prettified shape,
// then we union them and intersect with parent context
//
// Structure: ParentCtx (minus disc key) & BranchUnion
// This avoids cartesian product explosion by NOT distributing over ParentCtx first.
// The resulting type has the same number of union members as branches,
// regardless of how many unions exist in ParentCtx.
type BuildDiscriminatedUnion<
  ParentCtx extends Record<string, unknown>,
  DiscKey extends string,
  Branches extends BranchesRecord
> = OmitDistributive<ParentCtx, DiscKey> &
  {
    // Map each branch name to its complete shape, then index to create union
    [BranchName in keyof Branches & string]: BranchShape<
      ParentCtx,
      DiscKey,
      BranchName,
      Branches[BranchName]
    >;
  }[keyof Branches & string];

/**
 * Convert a union type to an intersection type.
 * Uses the contravariant position trick to transform union to intersection.
 * Example: UnionToIntersection<A | B | C> = A & B & C
 */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never;

// Build the discriminated union for CtxMeta - intersects all branch metas
type BuildDiscriminatedMetaUnion<
  ParentCtxMeta extends Record<string, unknown>,
  Branches extends BranchesRecord
> = Prettify<ParentCtxMeta & UnionToIntersection<InferGraphMeta<Branches[keyof Branches]>>>;

// Build an intersection of all possible value types from discriminator branches
// This provides a flat record of all possible node keys and their value types
// Uses InferGraphValues to get the CtxValues (intersection) from subgraphs,
// which includes nested discriminator values recursively
type BuildDiscriminatedValuesUnion<
  ParentCtx extends Record<string, unknown>,
  Branches extends BranchesRecord
> = Prettify<ParentCtx & UnionToIntersection<InferGraphValues<Branches[keyof Branches]>>>;

// ============================================================================
// Graph Entry Types (Runtime)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscriminatorFactory = (ctx: any, ext: any) => BranchesRecord;

type GraphEntry =
  | {
      kind: 'node';
      key: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: (ctx: any, ext: any, actions: any) => any;
      deps: readonly string[];
    }
  | {
      kind: 'computed';
      key: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compute: (ctx: any, ext: any) => any;
      deps: readonly string[];
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { kind: 'effect'; run: (ctx: any, ext: any, set: any) => void; deps: readonly string[] }
  | { kind: 'discriminator'; discriminatorKey: string; factory: DiscriminatorFactory };

// ============================================================================
// Active Entry Types (Runtime - entries with source tracking)
// ============================================================================

/** An entry that is currently active in the graph, with source tracking */
type ActiveEntry = GraphEntry & {
  /** The discriminator path that activated this entry (e.g., 'workflow:txt2img/modelFamily:flux') */
  source: string;
};

/** Tracks an active discriminator branch */
interface ActiveBranch {
  branch: string;
  /** Keys of entries added by this branch (for cleanup) */
  entryKeys: Set<string>;
}

// ============================================================================
// DataGraph Class
// ============================================================================

/**
 * A reactive data graph with type-safe discriminated unions and per-node typed meta.
 *
 * Architecture:
 * - Root graph maintains all state (_ctx, nodeDefs, nodeMeta, activeEntries)
 * - Subgraphs are templates that provide entry definitions
 * - When a discriminator activates, subgraph entries are added to root's activeEntries
 * - When a discriminator deactivates, those entries are removed
 * - Single evaluation loop processes all activeEntries on the root graph
 *
 * @template Ctx - The context type containing all node values (discriminated union)
 * @template ExternalCtx - External context passed from outside the graph
 * @template CtxMeta - Per-node meta type mapping (intersection of all branch metas)
 * @template CtxValues - All possible value types (intersection of all branch contexts)
 */
export type ValueProvider<Ctx> = (key: keyof Ctx & string, ctx: Ctx) => unknown | undefined;

export class DataGraph<
  Ctx extends Record<string, unknown> = EmptyObject,
  ExternalCtx extends Record<string, unknown> = EmptyObject,
  CtxMeta extends Record<string, unknown> = EmptyObject,
  CtxValues extends Record<string, unknown> = Ctx
> {
  /** Timestamp when this graph instance was created (useful for HMR debugging) */
  readonly createdAt = Date.now();

  /** Template entries defined on this graph (used when this graph is a subgraph template) */
  private entries: GraphEntry[] = [];

  /** Active entries currently being evaluated (only on root graph) */
  private activeEntries: ActiveEntry[] = [];

  /** Node definitions (schemas, defaults, meta) - only on root graph */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nodeDefs = new Map<string, any>();

  /** Node meta values - only on root graph */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nodeMeta = new Map<string, any>();

  /** Validation errors - only on root graph */
  private nodeErrors = new Map<string, NodeError>();

  /** Node watchers for subscriptions - only on root graph */
  private nodeWatchers = new Map<string, Set<NodeCallback>>();

  /** The context containing all node values - only on root graph */
  private _ctx: Ctx = {} as Ctx;

  /** External context passed from outside */
  private _ext: ExternalCtx = {} as ExternalCtx;

  /** Whether init() has been called */
  private _initialized = false;

  /** Debug mode flag */
  private _debug = false;

  /** Tracks which discriminator branches are currently active */
  private activeDiscriminators = new Map<string, ActiveBranch>();

  /** Set of computed node keys (for isComputed check) */
  private computedNodes = new Set<string>();

  /** Value provider for loading values (e.g., from storage) */
  private valueProvider?: ValueProvider<Ctx>;

  /** Cache for lazy branch factories */
  private lazyBranchCache = new Map<string, BranchGraph>();

  /** Storage adapter for persistence */
  private storageAdapter?: StorageAdapter<Ctx>;

  /** Snapshot cache for getSnapshot() */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private snapshotCache = new Map<string, NodeSnapshot<unknown, any>>();

  /** Meta keys for tracking meta changes */
  private nodeMetaKeys = new Map<string, number>();

  /** Global watchers for any change */
  private globalWatchers = new Set<() => void>();

  /** Scope dependencies for storage scoping */
  private scopeDependencies = new Map<string, Set<string>>();

  /** Reference to root graph (self-reference on root, parent reference on subgraphs) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rootGraph: DataGraph<any, any, any, any> = this;

  get ctx(): Ctx {
    return this.rootGraph._ctx as Ctx;
  }

  get ext(): ExternalCtx {
    return this.rootGraph._ext as ExternalCtx;
  }

  private addEntry(entry: GraphEntry): void {
    this.entries.push(entry);
    if (entry.kind === 'computed') {
      this.computedNodes.add(entry.key);
    }
  }

  /** Check if a key is a computed value */
  isComputed(key: keyof Ctx & string): boolean {
    return this.rootGraph.computedNodes.has(key);
  }

  /** Check if a node key currently exists in the context */
  hasNode(key: string): boolean {
    return key in this.rootGraph._ctx;
  }

  /**
   * Get meta for a specific node - strongly typed per-node.
   * Returns the exact meta type that was defined for this node.
   */
  getNodeMeta<K extends keyof CtxMeta & string>(key: K): CtxMeta[K] | undefined {
    return this.rootGraph.nodeMeta.get(key);
  }

  /** Get all current node meta */
  getAllMeta(): Partial<CtxMeta> {
    const result: Partial<CtxMeta> = {};
    this.rootGraph.nodeMeta.forEach((meta, key) => {
      (result as Record<string, unknown>)[key] = meta;
    });
    return result;
  }

  /** Get validation error for a specific node */
  getNodeError(key: keyof Ctx & string): NodeError | undefined {
    return this.rootGraph.nodeErrors.get(key);
  }

  /** Get all current validation errors */
  getErrors(): Record<string, NodeError | undefined> {
    const result: Record<string, NodeError | undefined> = {};
    for (const key of this.getNodeKeys()) {
      result[key] = this.rootGraph.nodeErrors.get(key);
    }
    return result;
  }

  /** Validate all node values against their output schemas */
  validate(): ValidationResult<Ctx> {
    const root = this.rootGraph;
    const previousErrorKeys = new Set(root.nodeErrors.keys());
    root.nodeErrors.clear();
    let isValid = true;
    const nodes: Record<string, NodeEntry> = {};

    for (const entry of root.activeEntries) {
      if (entry.kind === 'node') {
        const def = root.nodeDefs.get(entry.key);
        if (!def?.output) continue;

        const value = (root._ctx as Record<string, unknown>)[entry.key];
        const result = def.output.safeParse(value);
        if (!result.success) {
          const firstError = result.error?.issues?.[0];
          root.nodeErrors.set(entry.key, {
            message: firstError?.message ?? 'Validation failed',
            code: firstError?.code ?? 'unknown',
          });
          isValid = false;
        }
        nodes[entry.key] = { kind: 'node', key: entry.key, deps: entry.deps };
      } else if (entry.kind === 'computed') {
        nodes[entry.key] = { kind: 'computed', key: entry.key, deps: entry.deps };
      }
    }

    const keysToNotify = new Set([...root.nodeErrors.keys(), ...previousErrorKeys]);
    keysToNotify.forEach((key) => {
      root.notifyNodeWatchers(key);
    });

    if (isValid) {
      return { success: true, data: root._ctx as Ctx, nodes };
    }

    const errors: Record<string, NodeError> = {};
    root.nodeErrors.forEach((error, key) => {
      errors[key] = error;
    });

    return { success: false, errors };
  }

  private watchNode(key: string, callback: NodeCallback): () => void {
    const root = this.rootGraph;
    let callbacks = root.nodeWatchers.get(key);
    if (!callbacks) {
      callbacks = new Set();
      root.nodeWatchers.set(key, callbacks);
    }
    callbacks.add(callback);
    return () => {
      callbacks!.delete(callback);
      if (callbacks!.size === 0) {
        root.nodeWatchers.delete(key);
      }
    };
  }

  private notifyNodeWatchers(key: string) {
    const callbacks = this.rootGraph.nodeWatchers.get(key);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateMeta(key: string, newMeta: any | undefined) {
    const root = this.rootGraph;
    const oldMeta = root.nodeMeta.get(key);
    if (!isEqual(oldMeta, newMeta)) {
      if (newMeta === undefined) {
        root.nodeMeta.delete(key);
        root.nodeMetaKeys.delete(key);
      } else {
        root.nodeMeta.set(key, newMeta);
        root.nodeMetaKeys.set(key, Date.now());
      }
      root.notifyNodeWatchers(key);
    }
  }

  /** Get the unique meta key for a node (changes when meta changes) */
  getNodeMetaKey(key: keyof Ctx & string): number | undefined {
    return this.rootGraph.nodeMetaKeys.get(key);
  }

  /** Subscribe to graph changes */
  subscribe(callback: () => void): () => void;
  subscribe<K extends keyof Ctx & string>(key: K, callback: () => void): () => void;
  subscribe(keyOrCallback: string | (() => void), callback?: () => void): () => void {
    if (typeof keyOrCallback === 'function') {
      this.rootGraph.globalWatchers.add(keyOrCallback);
      return () => {
        this.rootGraph.globalWatchers.delete(keyOrCallback);
      };
    }
    return this.watchNode(keyOrCallback, callback!);
  }

  /** Get a snapshot of graph state */
  getSnapshot(): Ctx;
  getSnapshot<K extends keyof Ctx & string>(
    key: K
  ): NodeSnapshot<Ctx[K], K extends keyof CtxMeta ? CtxMeta[K] : unknown>;
  getSnapshot<K extends keyof Ctx & string>(
    key?: K
  ): Ctx | NodeSnapshot<Ctx[K], K extends keyof CtxMeta ? CtxMeta[K] : unknown> {
    const root = this.rootGraph;
    if (key === undefined) {
      return root._ctx as Ctx;
    }

    const value = (root._ctx as Ctx)[key];
    const meta = root.nodeMeta.get(key);
    const error = root.nodeErrors.get(key);
    const isComputed = root.computedNodes.has(key);
    const metaKey = root.nodeMetaKeys.get(key);

    const cached = root.snapshotCache.get(key);
    if (
      cached &&
      Object.is(cached.value, value) &&
      Object.is(cached.meta, meta) &&
      Object.is(cached.error, error) &&
      cached.isComputed === isComputed &&
      cached.metaKey === metaKey
    ) {
      return cached as NodeSnapshot<Ctx[K], K extends keyof CtxMeta ? CtxMeta[K] : unknown>;
    }

    const snapshot: NodeSnapshot<Ctx[K], K extends keyof CtxMeta ? CtxMeta[K] : unknown> = {
      value,
      meta,
      error,
      isComputed,
      metaKey,
    };
    root.snapshotCache.set(key, snapshot as NodeSnapshot<unknown, unknown>);
    return snapshot;
  }

  setValueProvider(provider: ValueProvider<Ctx> | undefined): void {
    this.rootGraph.valueProvider = provider;
  }

  /**
   * Register a scope dependency: when scopeKey changes, dependentKey should be re-evaluated.
   * This is used by storage adapters to ensure scoped values are reloaded from storage
   * when their scope changes.
   */
  addScopeDependency(scopeKey: string, dependentKey: string): void {
    const root = this.rootGraph;
    let deps = root.scopeDependencies.get(scopeKey);
    if (!deps) {
      deps = new Set();
      root.scopeDependencies.set(scopeKey, deps);
    }
    deps.add(dependentKey);
  }

  /**
   * Get all keys that depend on a given scope key.
   */
  getScopeDependencies(scopeKey: string): string[] {
    return Array.from(this.rootGraph.scopeDependencies.get(scopeKey) ?? []);
  }

  useStorage(adapter: StorageAdapter<Ctx>): this {
    this.storageAdapter = adapter;
    adapter.attach(this);
    return this;
  }

  getStorageAdapter(): StorageAdapter<Ctx> | undefined {
    return this.storageAdapter;
  }

  /**
   * Add a node with a static definition (always present).
   * Meta type is inferred from the meta value provided.
   */
  node<const K extends string, T extends AnyZodSchema, M>(
    key: K,
    def: {
      input?: AnyZodSchema;
      output: T;
      defaultValue?: InferOutput<T>;
      meta?: M;
    }
  ): DataGraph<
    MergeDistributive<Ctx, { [P in K]: InferOutput<T> }>,
    ExternalCtx,
    M extends undefined ? CtxMeta : Prettify<CtxMeta & { [P in K]: M }>,
    Prettify<CtxValues & { [P in K]: InferOutput<T> }>
  >;

  /**
   * Add a node with a factory function (no `when` - always present).
   * Meta type is inferred from what the factory returns.
   */
  node<const K extends string, const Deps extends readonly string[], T extends AnyZodSchema, M>(
    key: K,
    factory: (
      ctx: Ctx,
      ext: ExternalCtx,
      actions: GraphActions<Ctx>
    ) => {
      input?: AnyZodSchema;
      output: T;
      defaultValue?: InferOutput<T>;
      meta?: M;
      when?: undefined | true;
    },
    deps: Deps
  ): DataGraph<
    MergeDistributive<Ctx, { [P in K]: InferOutput<T> }>,
    ExternalCtx,
    M extends undefined ? CtxMeta : Prettify<CtxMeta & { [P in K]: M }>,
    Prettify<CtxValues & { [P in K]: InferOutput<T> }>
  >;

  /**
   * Add a conditional node with a factory function (has `when` boolean - optional in type).
   */
  node<const K extends string, const Deps extends readonly string[], T extends AnyZodSchema, M>(
    key: K,
    factory: (
      ctx: Ctx,
      ext: ExternalCtx,
      actions: GraphActions<Ctx>
    ) => {
      input?: AnyZodSchema;
      output: T;
      defaultValue?: InferOutput<T>;
      meta?: M;
      when: boolean;
    },
    deps: Deps
  ): DataGraph<
    MergeDistributive<Ctx, { [P in K]?: InferOutput<T> }>,
    ExternalCtx,
    M extends undefined ? CtxMeta : Prettify<CtxMeta & { [P in K]?: M }>,
    Prettify<CtxValues & { [P in K]?: InferOutput<T> }>
  >;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node(key: string, arg1: any, deps?: readonly string[]) {
    const isFactory = typeof arg1 === 'function';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory = isFactory ? arg1 : () => arg1;
    const nodeDeps = isFactory ? (Array.isArray(deps) ? deps : []) : [];

    this.addEntry({ kind: 'node', key, factory, deps: nodeDeps });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  /**
   * Add a discriminator that switches between sub-graphs based on a discriminator key.
   */
  discriminator<
    const DiscKey extends keyof Ctx & string,
    const Branches extends BranchesRecord<Ctx, ExternalCtx>
  >(
    key: DiscKey,
    branchesOrFactory: Branches | ((ctx: Ctx, ext: ExternalCtx) => Branches)
  ): DataGraph<
    BuildDiscriminatedUnion<Ctx, DiscKey, Branches>,
    ExternalCtx,
    BuildDiscriminatedMetaUnion<CtxMeta, Branches>,
    BuildDiscriminatedValuesUnion<CtxValues, Branches>
  > {
    const factory =
      typeof branchesOrFactory === 'function' ? branchesOrFactory : () => branchesOrFactory;
    this.addEntry({
      kind: 'discriminator',
      discriminatorKey: key,
      factory,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  /**
   * Merge another graph's nodes into this graph.
   *
   * Can be called with:
   * 1. A graph directly: `.merge(otherGraph)` - entries are added as-is
   * 2. A factory with deps: `.merge((ctx, ext) => createGraph(...), ['dep1', 'dep2'])`
   *    - Each entry's deps will be combined with the merge deps
   *    - Allows dynamic graph creation based on context
   */
  merge<
    ChildCtx extends Record<string, unknown>,
    ChildExternal extends Record<string, unknown>,
    ChildMeta extends Record<string, unknown>,
    ChildValues extends Record<string, unknown>
  >(
    graph: DataGraph<ChildCtx, ChildExternal, ChildMeta, ChildValues>
  ): ExternalCtx extends ChildExternal
    ? DataGraph<
        MergeDistributive<Ctx, ChildCtx>,
        ExternalCtx,
        Prettify<CtxMeta & ChildMeta>,
        Prettify<CtxValues & ChildValues>
      >
    : never;

  merge<
    ChildCtx extends Record<string, unknown>,
    ChildExternal extends Record<string, unknown>,
    ChildMeta extends Record<string, unknown>,
    ChildValues extends Record<string, unknown>,
    const Deps extends readonly (keyof Ctx & string)[]
  >(
    factory: (
      ctx: Ctx,
      ext: ExternalCtx
    ) => DataGraph<ChildCtx, ChildExternal, ChildMeta, ChildValues>,
    deps: Deps
  ): ExternalCtx extends ChildExternal
    ? DataGraph<
        MergeDistributive<Ctx, ChildCtx>,
        ExternalCtx,
        Prettify<CtxMeta & ChildMeta>,
        Prettify<CtxValues & ChildValues>
      >
    : never;

  // prettier-ignore
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  merge(graphOrFactory: DataGraph<any, any, any, any> | ((ctx: Ctx, ext: ExternalCtx) => DataGraph<any, any, any, any>), deps?: readonly string[]): any {
    if (typeof graphOrFactory === 'function') {
      // Factory mode: call factory once to get graph structure, then add entries with combined deps
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const templateGraph = graphOrFactory({} as any, {} as any);
      const mergeDeps = deps ?? [];

      for (const entry of templateGraph.entries) {
        switch (entry.kind) {
          case 'node': {
            // Wrap the node factory to re-call merge factory with current context
            const originalFactory = entry.factory;
            this.addEntry({
              kind: 'node',
              key: entry.key,
              factory: (ctx, ext, actions) => {
                const freshGraph = graphOrFactory(ctx, ext);
                const freshEntry = freshGraph.entries.find(
                  (e): e is typeof entry => e.kind === 'node' && e.key === entry.key
                );
                return freshEntry ? freshEntry.factory(ctx, ext, actions) : originalFactory(ctx, ext, actions);
              },
              deps: [...new Set([...entry.deps, ...mergeDeps])],
            });
            break;
          }
          case 'computed':
          case 'effect':
            this.addEntry({ ...entry, deps: [...new Set([...entry.deps, ...mergeDeps])] });
            break;
          case 'discriminator':
            this.addEntry(entry);
            break;
        }
      }
    } else {
      // Direct graph mode: copy entries as-is
      for (const entry of graphOrFactory.entries) {
        this.addEntry(entry);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  effect<const Deps extends readonly string[]>(fn: EffectFn<Ctx, ExternalCtx>, deps: Deps): this {
    this.addEntry({ kind: 'effect', run: fn, deps: deps as readonly string[] });
    return this;
  }

  /**
   * Add a computed (derived) value that is calculated from other nodes.
   */
  computed<const K extends string, T, const Deps extends readonly (keyof Ctx & string)[]>(
    key: K,
    compute: (ctx: Ctx, ext: ExternalCtx) => T,
    deps: Deps
  ): DataGraph<
    MergeDistributive<Ctx, { [P in K]: T }>,
    ExternalCtx,
    CtxMeta,
    Prettify<CtxValues & { [P in K]: T }>
  > {
    this.addEntry({
      kind: 'computed',
      key,
      compute,
      deps: deps as readonly string[],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  /**
   * Initialize the graph with optional input values and external context.
   */
  init(
    input: Partial<Ctx> = {},
    externalCtx: ExternalCtx = {} as ExternalCtx,
    parentCtx: Partial<Ctx> = {},
    debug = false,
    options: { skipStorage?: boolean } = {}
  ): Ctx {
    this._debug = debug;
    this._ext = externalCtx;
    this._ctx = { ...parentCtx } as Ctx;
    this._initialized = true;
    this.activeDiscriminators.clear();
    this.activeEntries = [];

    // Initialize activeEntries from template entries with 'root' source
    for (const entry of this.entries) {
      this.activeEntries.push({ ...entry, source: 'root' });
    }

    let mergedInput = input;
    if (this.storageAdapter && !options.skipStorage) {
      const storageValues = this.storageAdapter.getValues();
      mergedInput = { ...storageValues, ...input };
      this.storageAdapter.onBeforeEvaluate?.();
    } else if (options.skipStorage) {
      this.valueProvider = undefined;
    }

    const result = this._evaluate(mergedInput);

    if (this.storageAdapter) {
      this.storageAdapter.onInit();
    }

    return result;
  }

  set(values: Partial<Ctx>): Ctx {
    if (!this._initialized) throw new Error('Pipeline not initialized. Call init() first.');

    const result = this._evaluate(values);

    if (this.storageAdapter) {
      this.storageAdapter.onSet(values, result);
    }
    return result;
  }

  setExt(values: Partial<ExternalCtx>): Ctx {
    if (!this._initialized) throw new Error('Pipeline not initialized. Call init() first.');
    Object.assign(this._ext, values);
    return this._evaluate({});
  }

  reset(options: { exclude?: ((keyof Ctx | keyof CtxMeta) & string)[] } = {}): Ctx {
    const { exclude = [] } = options;

    const preservedValues: Record<string, unknown> = {};
    for (const key of exclude) {
      if (key in this._ctx) {
        preservedValues[key] = (this._ctx as Record<string, unknown>)[key];
      }
    }

    const result = this.init(preservedValues as Partial<Ctx>, this._ext, {}, this._debug, {
      skipStorage: true,
    });
    if (this.storageAdapter) {
      this.storageAdapter.onBeforeEvaluate?.();
    }
    return result;
  }

  clone(): DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues> {
    const cloned = new DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues>();
    cloned.entries = this.entries.map((e) => ({ ...e }));
    cloned._debug = this._debug;
    this.computedNodes.forEach((key) => cloned.computedNodes.add(key));
    this.lazyBranchCache.forEach((graph, key) => cloned.lazyBranchCache.set(key, graph));
    cloned.valueProvider = this.valueProvider;
    // Copy scope dependencies
    this.scopeDependencies.forEach((deps, key) => {
      cloned.scopeDependencies.set(key, new Set(deps));
    });
    return cloned;
  }

  /** Get all active node keys in the current context */
  getNodeKeys(): string[] {
    return Object.keys(this.rootGraph._ctx).filter((k) => !this.rootGraph.computedNodes.has(k));
  }

  /** Get node keys defined by this graph's template entries */
  getOwnNodeKeys(): string[] {
    const keys: string[] = [];
    for (const entry of this.entries) {
      if (entry.kind === 'node') {
        keys.push(entry.key);
      }
    }
    return keys;
  }

  /** Get all computed keys defined by this graph's template entries */
  getComputedKeys(): string[] {
    return this.entries.filter((e) => e.kind === 'computed').map((e) => e.key);
  }

  /** Get all possible keys across all discriminator branches */
  getAllPossibleKeys(): string[] {
    const keys = new Set<string>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collectKeys = (graph: DataGraph<any, any, any, any>) => {
      for (const entry of graph.entries) {
        if (entry.kind === 'node') {
          keys.add(entry.key);
        } else if (entry.kind === 'computed') {
          keys.add(entry.key);
        } else if (entry.kind === 'discriminator') {
          const branches = entry.factory({}, {});
          for (const branch of Object.values(branches)) {
            if (branch instanceof DataGraph) {
              collectKeys(branch);
            } else if (typeof branch === 'function') {
              try {
                const lazyGraph = branch({}, {});
                if (lazyGraph instanceof DataGraph) {
                  collectKeys(lazyGraph);
                }
              } catch {
                // If lazy factory fails, skip it
              }
            }
          }
        }
      }
    };

    collectKeys(this);
    return Array.from(keys);
  }

  // ===========================================================================
  // Branch Management - Add/Remove entries when discriminators change
  // ===========================================================================

  /**
   * Add entries from a subgraph to the active entries list.
   * Recursively handles nested discriminators.
   */
  private activateBranch(
    discriminatorKey: string,
    branchName: string,
    branchGraph: BranchGraph,
    insertAfterIndex: number
  ): { entryKeys: Set<string>; insertedCount: number } {
    const source = `${discriminatorKey}:${branchName}`;
    const entryKeys = new Set<string>();
    const newEntries: ActiveEntry[] = [];

    for (const entry of branchGraph.entries) {
      const activeEntry: ActiveEntry = { ...entry, source };
      newEntries.push(activeEntry);

      if (entry.kind === 'node' || entry.kind === 'computed') {
        entryKeys.add(entry.key);
        if (entry.kind === 'computed') {
          this.computedNodes.add(entry.key);
        }
      }
    }

    // Insert new entries after the discriminator entry
    this.activeEntries.splice(insertAfterIndex + 1, 0, ...newEntries);

    return { entryKeys, insertedCount: newEntries.length };
  }

  /**
   * Remove entries that were added by a specific discriminator branch.
   * Also removes nested discriminator entries recursively.
   */
  private deactivateBranch(discriminatorKey: string, branchName: string): void {
    const source = `${discriminatorKey}:${branchName}`;
    const sourcePrefix = `${source}/`;

    // Find all entries to remove (direct and nested)
    const entriesToRemove: ActiveEntry[] = [];
    for (const entry of this.activeEntries) {
      if (entry.source === source || entry.source.startsWith(sourcePrefix)) {
        entriesToRemove.push(entry);
      }
    }

    // Clean up state for removed entries
    for (const entry of entriesToRemove) {
      if (entry.kind === 'node' || entry.kind === 'computed') {
        delete (this._ctx as Record<string, unknown>)[entry.key];
        this.nodeMeta.delete(entry.key);
        this.nodeDefs.delete(entry.key);
        this.nodeErrors.delete(entry.key);
        if (entry.kind === 'computed') {
          this.computedNodes.delete(entry.key);
        }
        this.notifyNodeWatchers(entry.key);
      }
      if (entry.kind === 'discriminator') {
        // Clean up nested discriminator tracking
        this.activeDiscriminators.delete(entry.discriminatorKey);
      }
    }

    // Remove entries from activeEntries
    this.activeEntries = this.activeEntries.filter(
      (e) => e.source !== source && !e.source.startsWith(sourcePrefix)
    );
  }

  // ===========================================================================
  // Evaluation Loop
  // ===========================================================================

  private _evaluate(inputValues: Partial<Ctx> = {}): Ctx {
    const log = this._debug ? console.log.bind(console) : () => {};

    const changed = new Set<string>(Object.keys(inputValues));

    let iterations = 0;
    let currentIndex = 0;

    // Build key-to-index map for rewinding
    const rebuildKeyToIndex = () => {
      const map = new Map<string, number>();
      for (let i = 0; i < this.activeEntries.length; i++) {
        const entry = this.activeEntries[i];
        if (entry.kind === 'node' || entry.kind === 'computed') {
          map.set(entry.key, i);
        }
      }
      return map;
    };

    let keyToIndex = rebuildKeyToIndex();

    const effectSet = (key: string, value: unknown) => {
      const def = this.nodeDefs.get(key);
      if (!def) throw new Error(`Unknown node "${key}"`);

      // Use input schema if available (allows partial values with transforms)
      const schema = def.input ?? def.output;
      const next = schema.parse(value);

      if (!isEqual((this._ctx as Record<string, unknown>)[key], next)) {
        (this._ctx as Record<string, unknown>)[key] = next;
        changed.add(key);
        this.notifyNodeWatchers(key);

        // Rewind to the node if it's earlier in the list
        const nodeIndex = keyToIndex.get(key);
        if (nodeIndex !== undefined && nodeIndex < currentIndex) {
          currentIndex = nodeIndex;
        }
      }
    };

    while (currentIndex < this.activeEntries.length) {
      if (++iterations > 1000) throw new Error('Effect loop detected');

      const entry = this.activeEntries[currentIndex];

      if (entry.kind === 'node') {
        // Process if: no deps, a dep changed, OR this node's value is being set directly
        const isDirectUpdate = entry.key in inputValues;
        // Check if any scope dependency changed
        const isScopeDependencyChange = Array.from(this.scopeDependencies.entries()).some(
          ([scopeKey, dependentKeys]) => changed.has(scopeKey) && dependentKeys.has(entry.key)
        );
        const shouldProcess =
          isDirectUpdate ||
          isScopeDependencyChange ||
          entry.deps.length === 0 ||
          entry.deps.some((dep) => changed.has(dep));

        if (!shouldProcess) {
          currentIndex++;
          continue;
        }

        const actions: GraphActions<Ctx> = {
          set: (values) => this.set(values),
          reset: () => this.reset(),
        };
        const def = entry.factory(this._ctx, this._ext, actions);
        this.nodeDefs.set(entry.key, def);

        if (def.when === false) {
          if (entry.key in this._ctx) {
            delete (this._ctx as Record<string, unknown>)[entry.key];
            this.nodeMeta.delete(entry.key);
            this.nodeDefs.delete(entry.key);
            changed.add(entry.key);
            this.notifyNodeWatchers(entry.key);
          }
          currentIndex++;
          continue;
        }

        let inputValue: unknown;
        if (entry.key in inputValues) {
          inputValue = inputValues[entry.key as keyof Ctx];
        } else if (this.valueProvider) {
          const providedValue = this.valueProvider(entry.key, this._ctx);
          if (providedValue !== undefined) {
            inputValue = providedValue;
          } else if (isScopeDependencyChange) {
            inputValue = undefined;
          } else if (entry.key in this._ctx) {
            inputValue = this._ctx[entry.key as keyof Ctx];
          }
        } else if (entry.key in this._ctx) {
          inputValue = this._ctx[entry.key as keyof Ctx];
        }

        const raw = inputValue !== undefined ? inputValue : def.defaultValue;
        const inputSchema = def.input ?? def.output;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let next: any;
        try {
          next = inputSchema.parse(raw);
          if (next === undefined && def.defaultValue !== undefined) {
            next = def.defaultValue;
          }
        } catch {
          next = def.defaultValue ?? def.output.parse(def.defaultValue);
        }

        const keyExists = entry.key in this._ctx;
        const valueChanged = !isEqual(this._ctx[entry.key as keyof Ctx], next);
        if (!keyExists || valueChanged) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this._ctx as any)[entry.key] = next;
          changed.add(entry.key);
          if (valueChanged) {
            this.notifyNodeWatchers(entry.key);
          }
        }

        const metaValue =
          typeof def.meta === 'function' ? def.meta(this._ctx, this._ext) : def.meta ?? {};
        this.updateMeta(entry.key, metaValue);
      } else if (entry.kind === 'computed') {
        const shouldProcess = entry.deps.length === 0 || entry.deps.some((dep) => changed.has(dep));
        if (!shouldProcess) {
          currentIndex++;
          continue;
        }

        const keyExists = entry.key in this._ctx;
        const next = entry.compute(this._ctx, this._ext);
        const valueChanged = !isEqual(this._ctx[entry.key as keyof Ctx], next);
        if (!keyExists || valueChanged) {
          (this._ctx as Record<string, unknown>)[entry.key] = next;
          changed.add(entry.key);
          if (valueChanged) {
            this.notifyNodeWatchers(entry.key);
          }
        }
      } else if (entry.kind === 'discriminator') {
        const current = this.activeDiscriminators.get(entry.discriminatorKey);

        // Only process if discriminator key changed OR no branch is active yet
        if (!changed.has(entry.discriminatorKey) && current) {
          currentIndex++;
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const discriminatorValue = (this._ctx as any)[entry.discriminatorKey];
        const branches = entry.factory(this._ctx, this._ext);
        const targetBranch = discriminatorValue as string;
        const branchDef = targetBranch ? branches[targetBranch] : undefined;

        if (!branchDef) {
          if (current) {
            log(`  🔀 discriminator: no matching branch for "${targetBranch}", cleaning up`);
            this.deactivateBranch(entry.discriminatorKey, current.branch);
            this.activeDiscriminators.delete(entry.discriminatorKey);
            keyToIndex = rebuildKeyToIndex();
          }
          currentIndex++;
          continue;
        }

        const needsSwitch = !current || current.branch !== targetBranch;
        if (needsSwitch) {
          log(`  🔀 discriminator: switching to branch "${targetBranch}"`);

          // Deactivate old branch
          if (current) {
            this.deactivateBranch(entry.discriminatorKey, current.branch);
          }

          // Get or create branch graph
          const cacheKey = `${entry.discriminatorKey}:${targetBranch}`;
          let branchGraph: BranchGraph;
          if (typeof branchDef === 'function') {
            const cached = this.lazyBranchCache.get(cacheKey);
            if (cached) {
              branchGraph = cached;
            } else {
              branchGraph = branchDef(this._ctx, this._ext);
              this.lazyBranchCache.set(cacheKey, branchGraph);
              log(`  📦 lazy branch "${targetBranch}" instantiated and cached`);
            }
          } else {
            branchGraph = branchDef;
          }

          // Activate new branch - insert entries after this discriminator
          const { entryKeys } = this.activateBranch(
            entry.discriminatorKey,
            targetBranch,
            branchGraph,
            currentIndex
          );

          // Track active branch
          this.activeDiscriminators.set(entry.discriminatorKey, {
            branch: targetBranch,
            entryKeys,
          });

          // Rebuild key-to-index map since entries changed
          keyToIndex = rebuildKeyToIndex();

          // Mark all new entry keys as needing processing
          for (const key of entryKeys) {
            changed.add(key);
          }

          // Continue to next entry (the first of the newly inserted entries)
          // Don't increment currentIndex since we want to process the new entries
        }
      } else if (entry.kind === 'effect') {
        const depsChanged = entry.deps.some((dep) => changed.has(dep));
        if (!depsChanged) {
          currentIndex++;
          continue;
        }

        entry.run(this._ctx, this._ext, effectSet);
      }

      currentIndex++;
    }

    for (const callback of this.globalWatchers) callback();
    return this._ctx;
  }
}

// ============================================================================
// Helper Types for Extracting Graph Types
// ============================================================================

/**
 * Extract all types from a DataGraph definition.
 * Use this to get typed hooks without manual type parameters.
 *
 * @example
 * ```tsx
 * const graph = new DataGraph<{}, { maxSteps: number }>()
 *   .node('steps', { output: z.number(), defaultValue: 20, meta: { min: 1, max: 50 } });
 *
 * type GraphTypes = InferDataGraph<typeof graph>;
 * // GraphTypes.Ctx = { steps: number }
 * // GraphTypes.ExternalCtx = { maxSteps: number }
 * // GraphTypes.Meta = { steps: { min: number; max: number } }
 *
 * // In components:
 * const graph = useGraph<GraphTypes.Ctx, GraphTypes.ExternalCtx, GraphTypes.Meta>();
 * ```
 */
export type InferDataGraph<G> = G extends DataGraph<
  infer Ctx,
  infer ExternalCtx,
  infer CtxMeta,
  infer CtxValues
>
  ? {
      /** The context type containing all node values (discriminated union) */
      Ctx: Ctx;
      /** External context passed from outside the graph */
      ExternalCtx: ExternalCtx;
      /** Per-node meta type mapping (intersection of all branch metas) */
      Meta: CtxMeta;
      /** All possible value types (intersection of all branch contexts) */
      Values: CtxValues;
      /** The full graph type */
      Graph: DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues>;
    }
  : never;

// Export type utilities
export type {
  InferGraphContext,
  InferGraphMeta,
  BuildDiscriminatedUnion,
  InferOutput,
  AnyZodSchema,
  NodeError,
  GraphActions,
};
