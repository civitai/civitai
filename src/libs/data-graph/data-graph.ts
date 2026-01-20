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

// ============================================================================
// Grouped Discriminator Types
// ============================================================================

/**
 * A grouped branch definition - multiple discriminator values share one graph.
 * At the type level, this creates ONE union member with a union of string literals.
 */
interface GroupedBranch<
  Values extends readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Graph extends BranchDefinition<any, any>
> {
  /** The discriminator values that map to this graph */
  readonly values: Values;
  /** The graph for these values */
  readonly graph: Graph;
}

/** Array of grouped branches */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GroupedBranchesArray<Ctx = any, ExternalCtx = any> = readonly GroupedBranch<
  readonly string[],
  BranchDefinition<Ctx, ExternalCtx>
>[];

/**
 * Build discriminated union from grouped branches.
 * Each GroupedBranch creates ONE type branch with a union of its values.
 *
 * Example:
 *   GroupedBranch<['txt2img', 'img2img'], ecosystemGraph>
 *   → { workflow: 'txt2img' | 'img2img' } & EcosystemGraphCtx
 *
 * This reduces type complexity from O(n) branches to O(groups) branches.
 */
type BuildGroupedDiscriminatedUnion<
  ParentCtx extends Record<string, unknown>,
  DiscKey extends string,
  Groups extends GroupedBranchesArray
> = Groups extends readonly [infer First, ...infer Rest]
  ? First extends GroupedBranch<infer Values, infer Graph>
    ?
        | MergePreferRight<
            OmitDistributive<ParentCtx, DiscKey>,
            MergePreferRight<
              { [K in DiscKey]: Values[number] },
              OmitDistributive<InferGraphContext<Graph>, DiscKey>
            >
          >
        | (Rest extends GroupedBranchesArray
            ? BuildGroupedDiscriminatedUnion<ParentCtx, DiscKey, Rest>
            : never)
    : never
  : never;

/**
 * Lazy evaluation of grouped branch metas via mapped type.
 * TypeScript defers evaluation until property is accessed.
 */
type LazyGroupedBranchMetas<Groups extends GroupedBranchesArray> = {
  [K in keyof Groups]: Groups[K] extends GroupedBranch<readonly string[], infer Graph>
    ? InferGraphMeta<Graph>
    : never;
};

/**
 * Lazy evaluation of grouped branch values via mapped type.
 */
type LazyGroupedBranchValues<Groups extends GroupedBranchesArray> = {
  [K in keyof Groups]: Groups[K] extends GroupedBranch<readonly string[], infer Graph>
    ? InferGraphValues<Graph>
    : never;
};

/**
 * Build meta union from grouped branches.
 * Uses lazy evaluation via mapped type for better TypeScript performance.
 */
type BuildGroupedMetaUnion<
  ParentCtxMeta extends Record<string, unknown>,
  Groups extends GroupedBranchesArray
> = ParentCtxMeta & FlattenUnion<LazyGroupedBranchMetas<Groups>[keyof Groups & number]>;

/**
 * Build values union from grouped branches.
 * Uses lazy evaluation via mapped type for better TypeScript performance.
 */
type BuildGroupedValuesUnion<
  ParentCtx extends Record<string, unknown>,
  Groups extends GroupedBranchesArray
> = ParentCtx & FlattenUnion<LazyGroupedBranchValues<Groups>[keyof Groups & number]>;

// Helper: Distributive Omit that preserves discriminated unions
type OmitDistributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// Helper: Merge A and B, where B's types take precedence for overlapping keys
// Distributes over both A and B to preserve discriminated unions from either side.
// This is critical for nested discriminators: the parent's discriminated union (A)
// must be preserved when merging with branch shapes (B).
type MergePreferRight<A, B> = A extends unknown
  ? B extends unknown
    ? Prettify<Omit<A, keyof B> & B>
    : never
  : never;

// Helper: Get the branch shape - combines the discriminator literal with subgraph context
// The subgraph's InferGraphContext includes its nested discriminated unions.
// We omit the discriminator key from the subgraph since we set it to the literal BranchName.
type BranchShape<
  _ParentCtx extends Record<string, unknown>,
  DiscKey extends string,
  BranchName extends string,
  BranchGraph
> = MergePreferRight<
  { [K in DiscKey]: BranchName },
  OmitDistributive<InferGraphContext<BranchGraph>, DiscKey>
>;

// Build the discriminated union for Ctx
// Bottom-up approach: each branch produces its full shape (including nested discriminated unions),
// then we merge with parent context using MergePreferRight.
//
// MergePreferRight distributes over both sides, so:
// - Parent's discriminated union (from earlier discriminators) is preserved
// - Branch's discriminated union (from nested discriminators) is preserved
// This allows type narrowing to work for nested discriminators like: workflow -> input -> images
type BuildDiscriminatedUnion<
  ParentCtx extends Record<string, unknown>,
  DiscKey extends string,
  Branches extends BranchesRecord
> = {
  // Map each branch name to its complete shape (merged with parent, subgraph types preferred)
  [BranchName in keyof Branches & string]: MergePreferRight<
    OmitDistributive<ParentCtx, DiscKey>,
    BranchShape<ParentCtx, DiscKey, BranchName, Branches[BranchName]>
  >;
}[keyof Branches & string];

/**
 * Lazy branch type maps - TypeScript defers evaluation of mapped type
 * properties until they are directly accessed.
 *
 * By using a mapped type over branches, TypeScript only evaluates each branch's
 * types when that specific property is accessed, rather than eagerly computing
 * all branches when the type is first encountered.
 *
 * @see https://trpc.io/blog/typescript-performance-lessons
 */
type LazyBranchMetas<Branches extends BranchesRecord> = {
  [K in keyof Branches]: InferGraphMeta<Branches[K]>;
};

type LazyBranchValues<Branches extends BranchesRecord> = {
  [K in keyof Branches]: InferGraphValues<Branches[K]>;
};

/**
 * Flatten a union of objects into a single object type.
 * Creates a type where each key maps to a union of all possible values
 * for that key across all branches.
 *
 * This is more TypeScript-friendly than intersection for Controller lookups because:
 * 1. It doesn't force eager evaluation of all branch types
 * 2. The resulting type is simpler (union of values vs intersection of objects)
 *
 * Example:
 *   FlattenUnion<{ a: string } | { a: number, b: boolean }>
 *   = { a: string | number; b: boolean | never }
 */
type FlattenUnion<T> = {
  [K in T extends unknown ? keyof T : never]: T extends unknown
    ? K extends keyof T
      ? T[K]
      : never
    : never;
};

/**
 * Build the CtxMeta type by combining all branch metas.
 *
 * Uses FlattenUnion for better TypeScript performance with large graphs.
 * Each key maps to a union of all possible meta types for that node.
 *
 * Note: We avoid Prettify here to reduce type evaluation overhead.
 */
type BuildDiscriminatedMetaUnion<
  ParentCtxMeta extends Record<string, unknown>,
  Branches extends BranchesRecord
> = ParentCtxMeta & FlattenUnion<LazyBranchMetas<Branches>[keyof Branches]>;

/**
 * Build the CtxValues type by combining all branch values.
 * This provides a flat record of all possible node keys and their value types.
 *
 * Uses FlattenUnion for better TypeScript performance with large graphs.
 * Note: We avoid Prettify here to reduce type evaluation overhead.
 */
type BuildDiscriminatedValuesUnion<
  ParentCtx extends Record<string, unknown>,
  Branches extends BranchesRecord
> = ParentCtx & FlattenUnion<LazyBranchValues<Branches>[keyof Branches]>;

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

  /**
   * Validate current graph state against output schemas.
   *
   * This method validates the current internal state of an initialized graph.
   * It updates `nodeErrors`, notifies watchers of error changes, and returns
   * a ValidationResult.
   *
   * For non-mutating validation of arbitrary data, use `safeParse()` instead.
   *
   * @returns ValidationResult with either validated data or errors
   *
   * @example
   * ```typescript
   * // Validate current state (for React forms)
   * const result = graph.validate();
   *
   * // Non-mutating validation of arbitrary data (use safeParse)
   * const result = templateGraph.safeParse(userInput, { session });
   * ```
   */
  validate(): ValidationResult<Ctx> {
    const root = this.rootGraph;

    // Evaluate with validateOnly mode - this populates nodeErrors and notifies watchers
    this._evaluate(root._ctx, true);

    return this._buildValidationResult(root);
  }

  /** Build a ValidationResult from the current graph state */
  private _buildValidationResult(
    graph: DataGraph<Ctx, ExternalCtx, CtxMeta, CtxValues>
  ): ValidationResult<Ctx> {
    const errors: Record<string, NodeError> = {};
    const nodes: Record<string, NodeEntry> = {};

    for (const entry of graph.activeEntries) {
      if (entry.kind === 'node') {
        const error = graph.nodeErrors.get(entry.key);
        if (error) {
          errors[entry.key] = error;
        }
        nodes[entry.key] = { kind: 'node', key: entry.key, deps: entry.deps };
      } else if (entry.kind === 'computed') {
        nodes[entry.key] = { kind: 'computed', key: entry.key, deps: entry.deps };
      }
    }

    if (Object.keys(errors).length === 0) {
      return { success: true, data: graph._ctx as Ctx, nodes };
    }

    return { success: false, errors };
  }

  /**
   * Validate input against output schemas without mutating the original graph.
   * Creates an isolated clone, sets up state, evaluates, and validates.
   *
   * Use this for server-side validation where the template graph should remain unchanged.
   *
   * @param input - Values to validate
   * @param externalCtx - External context for node factories
   * @returns ValidationResult with either validated data or errors
   *
   * @example
   * ```typescript
   * // Server-side validation
   * const result = generationGraph.safeParse(userInput, { session });
   * if (result.success) {
   *   // result.data contains validated values
   * } else {
   *   // result.errors contains validation errors
   * }
   * ```
   */
  safeParse(
    input: Partial<Ctx> = {},
    externalCtx: ExternalCtx = {} as ExternalCtx
  ): ValidationResult<Ctx> {
    const clone = this.clone();
    clone._setup(externalCtx);
    clone._evaluate(input, true);

    return clone._buildValidationResult(clone);
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
      /** Transform value when dependencies change. Runs after parsing input, before setting value. */
      transform?: (value: InferOutput<T>, ctx: Ctx, ext: ExternalCtx) => InferOutput<T>;
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
      /** Transform value when dependencies change. Runs after parsing input, before setting value. */
      transform?: (value: InferOutput<T>, ctx: Ctx, ext: ExternalCtx) => InferOutput<T>;
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
   *
   * Note: Ctx uses optional `[P in K]?` because the node may not exist (when=false).
   * But CtxValues uses required `[P in K]` because when the node IS active (Controller renders),
   * the value is always defined (uses defaultValue or input value).
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
      /** Transform value when dependencies change. Runs after parsing input, before setting value. */
      transform?: (value: InferOutput<T>, ctx: Ctx, ext: ExternalCtx) => InferOutput<T>;
    },
    deps: Deps
  ): DataGraph<
    MergeDistributive<Ctx, { [P in K]?: InferOutput<T> }>,
    ExternalCtx,
    M extends undefined ? CtxMeta : Prettify<CtxMeta & { [P in K]: M }>,
    Prettify<CtxValues & { [P in K]: InferOutput<T> }>
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
   * Add a grouped discriminator that collapses multiple values into fewer type branches.
   *
   * This is useful when many discriminator values share the same subgraph - instead of
   * creating a type union member for each value, this creates ONE member per group.
   *
   * @example
   * ```typescript
   * // Before: 12 branches → 12 type union members
   * .discriminator('workflow', {
   *   txt2img: ecosystemGraph,
   *   'txt2img:draft': ecosystemGraph,
   *   // ... 10 more pointing to ecosystemGraph
   *   'vid2vid:interpolate': videoInterpolationGraph,
   * })
   *
   * // After: 5 groups → 5 type union members
   * .groupedDiscriminator('workflow', [
   *   { values: ['txt2img', 'txt2img:draft', ...] as const, graph: ecosystemGraph },
   *   { values: ['vid2vid:interpolate'] as const, graph: videoInterpolationGraph },
   *   // ...
   * ])
   * ```
   */
  groupedDiscriminator<
    const DiscKey extends keyof Ctx & string,
    const Groups extends GroupedBranchesArray<Ctx, ExternalCtx>
  >(
    key: DiscKey,
    groups: Groups
  ): DataGraph<
    BuildGroupedDiscriminatedUnion<Ctx, DiscKey, Groups>,
    ExternalCtx,
    BuildGroupedMetaUnion<CtxMeta, Groups>,
    BuildGroupedValuesUnion<CtxValues, Groups>
  > {
    // Convert grouped branches to a flat BranchesRecord for runtime
    const branches: BranchesRecord = {};
    for (const group of groups) {
      for (const value of group.values) {
        branches[value] = group.graph;
      }
    }

    this.addEntry({
      kind: 'discriminator',
      discriminatorKey: key,
      factory: () => branches,
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
          case 'computed': {
            // Wrap the computed function to re-call merge factory with current context
            // This ensures computed functions use fresh closure values (e.g., versions)
            const originalCompute = entry.compute;
            this.addEntry({
              kind: 'computed',
              key: entry.key,
              compute: (ctx, ext) => {
                const freshGraph = graphOrFactory(ctx, ext);
                const freshEntry = freshGraph.entries.find(
                  (e): e is typeof entry => e.kind === 'computed' && e.key === entry.key
                );
                return freshEntry ? freshEntry.compute(ctx, ext) : originalCompute(ctx, ext);
              },
              deps: [...new Set([...entry.deps, ...mergeDeps])],
            });
            break;
          }
          case 'effect': {
            // Wrap the effect function to re-call merge factory with current context
            const originalRun = entry.run;
            this.addEntry({
              kind: 'effect',
              run: (ctx, ext, set) => {
                const freshGraph = graphOrFactory(ctx, ext);
                const freshEntry = freshGraph.entries.find(
                  (e): e is typeof entry => e.kind === 'effect' && e.run === originalRun
                );
                return freshEntry ? freshEntry.run(ctx, ext, set) : originalRun(ctx, ext, set);
              },
              deps: [...new Set([...entry.deps, ...mergeDeps])],
            });
            break;
          }
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
   * Set up internal state for evaluation (shared by init and validate).
   * This prepares the graph for evaluation without handling storage or watchers.
   */
  private _setup(externalCtx: ExternalCtx): void {
    this._ext = externalCtx;
    this._ctx = {} as Ctx;
    this.activeDiscriminators.clear();
    this.activeEntries = [];

    // Initialize activeEntries from template entries with 'root' source
    for (const entry of this.entries) {
      this.activeEntries.push({ ...entry, source: 'root' });
    }
  }

  /**
   * Initialize the graph with optional input values and external context.
   *
   * @param options.debug - Enable debug logging
   * @param options.skipStorage - Skip loading values from storage adapter
   */
  init(
    input: Partial<Ctx> = {},
    externalCtx: ExternalCtx = {} as ExternalCtx,
    options: { debug?: boolean; skipStorage?: boolean } = {}
  ): Ctx {
    this._debug = options.debug ?? false;
    this._initialized = true;

    // Use common setup
    this._setup(externalCtx);

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

    const result = this.init(preservedValues as Partial<Ctx>, this._ext, {
      debug: this._debug,
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
   *
   * @param discriminatorKey - The discriminator key (e.g., 'workflow', 'input')
   * @param branchName - The branch being activated (e.g., 'txt2img', 'image')
   * @param branchGraph - The subgraph to activate
   * @param insertAfterIndex - Index to insert entries after
   * @param parentSource - Parent discriminator's source for nested discriminators
   */
  private activateBranch(
    discriminatorKey: string,
    branchName: string,
    branchGraph: BranchGraph,
    insertAfterIndex: number,
    parentSource?: string
  ): { entryKeys: Set<string>; insertedCount: number } {
    // Build source path: for nested discriminators, include parent path
    // e.g., 'workflow:txt2img/input:image' for input discriminator inside workflow branch
    // Root discriminators (parentSource === 'root') don't include 'root' in the path
    const source =
      parentSource && parentSource !== 'root'
        ? `${parentSource}/${discriminatorKey}:${branchName}`
        : `${discriminatorKey}:${branchName}`;
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
   *
   * @param discriminatorKey - The discriminator key (e.g., 'modelFamily')
   * @param branchName - The branch being deactivated (e.g., 'flux2')
   * @param parentSource - The parent discriminator's source for building hierarchical path
   */
  private deactivateBranch(
    discriminatorKey: string,
    branchName: string,
    parentSource?: string
  ): void {
    // Build the source path matching how activateBranch builds it
    const source =
      parentSource && parentSource !== 'root'
        ? `${parentSource}/${discriminatorKey}:${branchName}`
        : `${discriminatorKey}:${branchName}`;
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
        // Notify watchers - batched during evaluation to prevent UI flicker
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

  private _evaluate(inputValues: Partial<Ctx> = {}, validateOnly = false): Ctx {
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
        // Check if this node was just activated from a branch switch
        // (its key is in changed, meaning activateBranch just added it)
        const isFromBranchActivation = changed.has(entry.key);
        const shouldProcess =
          isDirectUpdate ||
          isScopeDependencyChange ||
          isFromBranchActivation ||
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let next: any;

        if (validateOnly) {
          // In validateOnly mode, skip parsing entirely - use raw value directly.
          // validate() will check against output schema after evaluation completes.
          // This ensures no transforms/coercion happen during pure validation.
          next = raw;
        } else {
          // Normal mode: use input schema if available (allows transforms)
          const schema = def.input ?? def.output;
          try {
            next = schema.parse(raw);
            if (next === undefined && def.defaultValue !== undefined) {
              next = def.defaultValue;
            }
          } catch {
            next = def.defaultValue ?? def.output.parse(def.defaultValue);
          }

          // Apply transform when deps changed (not on direct input)
          // Transform allows updating value based on context changes
          const depsChanged = entry.deps.some((dep) => changed.has(dep));
          if (def.transform && depsChanged && !isDirectUpdate) {
            next = def.transform(next, this._ctx, this._ext);
          }
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

        // In validateOnly mode, validate against output schema and populate nodeErrors
        if (validateOnly) {
          const hadError = this.nodeErrors.has(entry.key);
          const result = def.output.safeParse(next);
          if (!result.success) {
            const firstError = result.error?.issues?.[0];
            this.nodeErrors.set(entry.key, {
              message: firstError?.message ?? 'Validation failed',
              code: firstError?.code ?? 'unknown',
            });
            // Notify if error is new
            if (!hadError) {
              this.notifyNodeWatchers(entry.key);
            }
          } else {
            // Use Zod-parsed data to strip extra fields not in schema
            (this._ctx as Record<string, unknown>)[entry.key] = result.data;
            if (hadError) {
              // Error cleared
              this.nodeErrors.delete(entry.key);
              this.notifyNodeWatchers(entry.key);
            }
          }
        }

        const metaValue =
          typeof def.meta === 'function' ? def.meta(this._ctx, this._ext) : def.meta ?? {};
        this.updateMeta(entry.key, metaValue);
      } else if (entry.kind === 'computed') {
        // Check if this node was just activated from a branch switch
        const isFromBranchActivation = changed.has(entry.key);
        const shouldProcess =
          isFromBranchActivation ||
          entry.deps.length === 0 ||
          entry.deps.some((dep) => changed.has(dep));

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
            // Pass entry.source to build correct hierarchical path for nested discriminators
            this.deactivateBranch(entry.discriminatorKey, current.branch, entry.source);
            this.activeDiscriminators.delete(entry.discriminatorKey);
            keyToIndex = rebuildKeyToIndex();
          }
          currentIndex++;
          continue;
        }

        const needsSwitch = !current || current.branch !== targetBranch;
        if (needsSwitch) {
          log(`  🔀 discriminator: switching to branch "${targetBranch}"`);

          // Deactivate old branch - pass entry.source for correct hierarchical path
          if (current) {
            this.deactivateBranch(entry.discriminatorKey, current.branch, entry.source);
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
          // Pass the discriminator entry's source as parent for nested discriminators
          const { entryKeys } = this.activateBranch(
            entry.discriminatorKey,
            targetBranch,
            branchGraph,
            currentIndex,
            entry.source // Parent source for nested path tracking
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

          // Fall through to increment currentIndex, which will point to the first inserted entry
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
  BuildGroupedDiscriminatedUnion,
  GroupedBranch,
  GroupedBranchesArray,
  InferOutput,
  AnyZodSchema,
  NodeError,
  GraphActions,
};
