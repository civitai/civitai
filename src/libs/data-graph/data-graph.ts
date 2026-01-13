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
type InferGraphContext<G> = G extends DataGraph<infer Ctx, any, any>
  ? Ctx
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
  G extends (ctx: any, ext: any) => DataGraph<infer Ctx, any, any>
  ? Ctx
  : never;

// Extract the CtxMeta type from a DataGraph
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferGraphMeta<G> = G extends DataGraph<any, any, infer CtxMeta>
  ? CtxMeta
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
  G extends (ctx: any, ext: any) => DataGraph<any, any, infer CtxMeta>
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

// Build the discriminated union for Ctx - FLAT structure (no prefixing)
type BuildDiscriminatedUnion<
  ParentCtx extends Record<string, unknown>,
  DiscKey extends string,
  Branches extends BranchesRecord
> = {
  [BranchName in keyof Branches]: Prettify<
    Omit<ParentCtx, DiscKey> & { [K in DiscKey]: BranchName } & InferGraphContext<
        Branches[BranchName]
      >
  >;
}[keyof Branches];

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
// DataGraph Class
// ============================================================================

/**
 * A reactive data graph with type-safe discriminated unions and per-node typed meta.
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

  private entries: GraphEntry[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nodeDefs = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nodeMeta = new Map<string, any>();
  private nodeErrors = new Map<string, NodeError>();
  private nodeWatchers = new Map<string, Set<NodeCallback>>();
  private _ctx: Ctx = {} as Ctx;
  private _ext: ExternalCtx = {} as ExternalCtx;
  private _initialized = false;
  private _debug = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private activeDiscriminators = new Map<
    string,
    { branch: string; subGraph: DataGraph<any, any, any, any> }
  >();
  private computedNodes = new Set<string>();
  private valueProvider?: ValueProvider<Ctx>;
  private lazyBranchCache = new Map<string, BranchGraph>();
  private storageAdapter?: StorageAdapter<Ctx>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private snapshotCache = new Map<string, NodeSnapshot<unknown, any>>();
  private nodeMetaKeys = new Map<string, number>();
  private globalWatchers = new Set<() => void>();
  /**
   * Reference to the root graph for notifying watchers during cleanup.
   * When a discriminator branch is cleaned up, we need to notify watchers on
   * the root graph (where Controllers subscribe), not just the subgraph.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rootGraph?: DataGraph<any, any, any, any>;
  /**
   * Scope dependencies: maps scope keys to the node keys that depend on them.
   * When a scope key changes, the dependent nodes should be re-evaluated
   * to load fresh values from storage.
   */
  private scopeDependencies = new Map<string, Set<string>>();

  get ctx(): Ctx {
    return this._ctx;
  }

  get ext(): ExternalCtx {
    return this._ext;
  }

  private addEntry(entry: GraphEntry): void {
    this.entries.push(entry);
    if (entry.kind === 'computed') {
      this.computedNodes.add(entry.key);
    }
  }

  /** Check if a key is a computed value */
  isComputed(key: keyof Ctx & string): boolean {
    return this.computedNodes.has(key);
  }

  /** Check if a node key currently exists in the context */
  hasNode(key: string): boolean {
    return key in this._ctx;
  }

  /**
   * Get meta for a specific node - strongly typed per-node.
   * Returns the exact meta type that was defined for this node.
   */
  getNodeMeta<K extends keyof CtxMeta & string>(key: K): CtxMeta[K] | undefined {
    return this.nodeMeta.get(key);
  }

  /** Get all current node meta */
  getAllMeta(): Partial<CtxMeta> {
    const result: Partial<CtxMeta> = {};
    this.nodeMeta.forEach((meta, key) => {
      (result as Record<string, unknown>)[key] = meta;
    });
    return result;
  }

  /** Get validation error for a specific node */
  getNodeError(key: keyof Ctx & string): NodeError | undefined {
    return this.nodeErrors.get(key);
  }

  /** Get all current validation errors */
  getErrors(): Record<string, NodeError | undefined> {
    const result: Record<string, NodeError | undefined> = {};
    for (const key of this.getNodeKeys()) {
      result[key] = this.nodeErrors.get(key);
    }
    return result;
  }

  /** Validate all node values against their output schemas */
  validate(): ValidationResult<Ctx> {
    const previousErrorKeys = new Set(this.nodeErrors.keys());
    this.nodeErrors.clear();
    let isValid = true;
    const nodes: Record<string, NodeEntry> = {};

    for (const entry of this.entries) {
      if (entry.kind === 'node') {
        const def = this.nodeDefs.get(entry.key);
        if (!def?.output) continue;

        const value = (this._ctx as Record<string, unknown>)[entry.key];
        const result = def.output.safeParse(value);
        if (!result.success) {
          const firstError = result.error?.issues?.[0];
          this.nodeErrors.set(entry.key, {
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

    for (const [, { subGraph }] of this.activeDiscriminators) {
      const subResult = subGraph.validate();
      if (!subResult.success) {
        isValid = false;
        for (const [key, error] of Object.entries(subResult.errors)) {
          if (error) {
            this.nodeErrors.set(key, error);
          }
        }
      } else {
        Object.assign(nodes, subResult.nodes);
      }
    }

    const keysToNotify = new Set([...this.nodeErrors.keys(), ...previousErrorKeys]);
    keysToNotify.forEach((key) => {
      this.notifyNodeWatchers(key);
    });

    if (isValid) {
      return { success: true, data: this._ctx, nodes };
    }

    const errors: Record<string, NodeError> = {};
    this.nodeErrors.forEach((error, key) => {
      errors[key] = error;
    });

    return { success: false, errors };
  }

  private watchNode(key: string, callback: NodeCallback): () => void {
    let callbacks = this.nodeWatchers.get(key);
    if (!callbacks) {
      callbacks = new Set();
      this.nodeWatchers.set(key, callbacks);
    }
    callbacks.add(callback);
    return () => {
      callbacks!.delete(callback);
      if (callbacks!.size === 0) {
        this.nodeWatchers.delete(key);
      }
    };
  }

  private notifyNodeWatchers(key: string) {
    const callbacks = this.nodeWatchers.get(key);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateMeta(key: string, newMeta: any | undefined) {
    const oldMeta = this.nodeMeta.get(key);
    if (!isEqual(oldMeta, newMeta)) {
      if (newMeta === undefined) {
        this.nodeMeta.delete(key);
        this.nodeMetaKeys.delete(key);
      } else {
        this.nodeMeta.set(key, newMeta);
        this.nodeMetaKeys.set(key, Date.now());
      }
      this.notifyNodeWatchers(key);
    }
  }

  // ===========================================================================
  // Subgraph Helper Methods
  // ===========================================================================

  /**
   * Sync values from a subgraph back to the parent context.
   * Returns the set of keys that changed.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private syncSubgraphValues(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subGraph: DataGraph<any, any, any, any>,
    subNodeKeys: string[],
    changed: Set<string>
  ): void {
    for (const subKey of subNodeKeys) {
      // Skip nodes that don't exist in subgraph (e.g., when: false)
      if (!(subKey in subGraph.ctx)) {
        // If the key exists in parent but not in subgraph, remove it from parent
        if (subKey in this._ctx) {
          delete (this._ctx as Record<string, unknown>)[subKey];
          this.nodeMeta.delete(subKey);
          changed.add(subKey);
          this.notifyNodeWatchers(subKey);
        }
        continue;
      }
      const subValue = (subGraph.ctx as Record<string, unknown>)[subKey];
      const keyExists = subKey in this._ctx;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const valueChanged = !isEqual((this._ctx as any)[subKey], subValue);
      // Sync if: key doesn't exist in parent (new key) OR value changed
      if (!keyExists || valueChanged) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._ctx as any)[subKey] = subValue;
        changed.add(subKey);
        if (valueChanged) {
          this.notifyNodeWatchers(subKey);
        }
      }
    }
  }

  /**
   * Sync meta from a subgraph back to the parent.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private syncSubgraphMeta(subGraph: DataGraph<any, any, any, any>, subNodeKeys: string[]): void {
    const subMeta = subGraph.getAllMeta();
    for (const [subKey, meta] of Object.entries(subMeta)) {
      if (subNodeKeys.includes(subKey)) {
        this.updateMeta(subKey, meta);
      }
    }
  }

  /**
   * Clean up nodes from an old subgraph that is being deactivated.
   * Recursively cleans up nested discriminator nodes.
   * Deletes from and notifies watchers on the root graph (where Controllers subscribe).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cleanupSubgraphNodes(subGraph: DataGraph<any, any, any, any>): void {
    // Always delete from and notify the root graph - that's where Controllers subscribe
    const rootGraph = this.rootGraph ?? this;
    // Clean up this subgraph's own nodes
    const ownKeys = [...subGraph.getOwnNodeKeys(), ...subGraph.getComputedKeys()];
    for (const oldKey of ownKeys) {
      delete (rootGraph._ctx as Record<string, unknown>)[oldKey];
      rootGraph.nodeMeta.delete(oldKey);
      rootGraph.nodeErrors.delete(oldKey);
      rootGraph.notifyNodeWatchers(oldKey);
    }
    // Recursively clean up nested discriminator nodes
    for (const [, { subGraph: nestedGraph }] of subGraph.activeDiscriminators) {
      this.cleanupSubgraphNodes(nestedGraph);
    }
  }

  /**
   * Recursively sync values and meta from nested discriminator subgraphs.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private syncNestedDiscriminatorNodes(
    subGraph: DataGraph<any, any, any, any>,
    changed: Set<string>
  ): void {
    for (const [, { subGraph: nestedGraph }] of subGraph.activeDiscriminators) {
      const nestedKeys = [...nestedGraph.getOwnNodeKeys(), ...nestedGraph.getComputedKeys()];
      this.syncSubgraphValues(nestedGraph, nestedKeys, changed);
      this.syncSubgraphMeta(nestedGraph, nestedKeys);
      // Recursively sync deeper nested discriminators
      this.syncNestedDiscriminatorNodes(nestedGraph, changed);
    }
  }

  /**
   * Prepare a subgraph for use by copying parent's valueProvider, scope dependencies,
   * and setting the root graph reference for proper watcher notifications.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private prepareSubgraph(subGraph: DataGraph<any, any, any, any>): void {
    // Set root graph reference - propagate the root from parent, or use this graph if it's the root
    subGraph.rootGraph = this.rootGraph ?? this;

    if (this.valueProvider) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subGraph.setValueProvider(this.valueProvider as ValueProvider<any>);
    }
    // Copy parent's scope dependencies to subgraph so scoped values work correctly
    this.scopeDependencies.forEach((deps, scopeKey) => {
      deps.forEach((depKey) => {
        subGraph.addScopeDependency(scopeKey, depKey);
      });
    });
  }

  /**
   * Update a subgraph's context with changed parent values.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateSubgraphParentContext(
    subGraph: DataGraph<any, any, any, any>,
    changedKeys: string[]
  ): void {
    for (const key of changedKeys) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (subGraph as any)._ctx[key] = (this._ctx as any)[key];
    }
  }

  /**
   * Sync a subgraph's values and meta back to the parent context.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private syncSubgraph(subGraph: DataGraph<any, any, any, any>, changed: Set<string>): void {
    const ownKeys = [...subGraph.getOwnNodeKeys(), ...subGraph.getComputedKeys()];
    this.syncSubgraphValues(subGraph, ownKeys, changed);
    this.syncSubgraphMeta(subGraph, ownKeys);
    this.syncNestedDiscriminatorNodes(subGraph, changed);
  }

  /**
   * Re-evaluate a subgraph and sync its values/meta back to the parent.
   * Handles forwarding input values to nested discriminators.
   */
  private evaluateAndSyncSubgraph(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subGraph: DataGraph<any, any, any, any>,
    inputValues: Partial<Ctx>,
    changed: Set<string>
  ): void {
    const subNodeKeys = subGraph.getOwnNodeKeys();
    const subComputedKeys = subGraph.getComputedKeys();

    // Check for parent context changes that the sub-graph depends on
    const parentChangedKeys = Array.from(changed).filter(
      (k) => !subNodeKeys.includes(k) && !subComputedKeys.includes(k) && k in this._ctx
    );

    const hasInputValues = Object.keys(inputValues).length > 0;
    if (parentChangedKeys.length > 0 || hasInputValues) {
      this.updateSubgraphParentContext(subGraph, parentChangedKeys);
      subGraph.setExt(this._ext);
      // Forward all input values to allow nested discriminators to receive their values
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (subGraph as any)._evaluate(inputValues, parentChangedKeys);
    } else {
      subGraph.setExt(this._ext);
    }

    this.syncSubgraph(subGraph, changed);
  }

  /** Get the unique meta key for a node (changes when meta changes) */
  getNodeMetaKey(key: keyof Ctx & string): number | undefined {
    return this.nodeMetaKeys.get(key);
  }

  /** Subscribe to graph changes */
  subscribe(callback: () => void): () => void;
  subscribe<K extends keyof Ctx & string>(key: K, callback: () => void): () => void;
  subscribe(keyOrCallback: string | (() => void), callback?: () => void): () => void {
    if (typeof keyOrCallback === 'function') {
      this.globalWatchers.add(keyOrCallback);
      return () => {
        this.globalWatchers.delete(keyOrCallback);
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
    if (key === undefined) {
      return this._ctx;
    }

    const value = this._ctx[key];
    const meta = this.nodeMeta.get(key);
    const error = this.nodeErrors.get(key);
    const isComputed = this.computedNodes.has(key);
    const metaKey = this.nodeMetaKeys.get(key);

    const cached = this.snapshotCache.get(key);
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
    this.snapshotCache.set(key, snapshot as NodeSnapshot<unknown, unknown>);
    return snapshot;
  }

  setValueProvider(provider: ValueProvider<Ctx> | undefined): void {
    this.valueProvider = provider;
  }

  /**
   * Register a scope dependency: when scopeKey changes, dependentKey should be re-evaluated.
   * This is used by storage adapters to ensure scoped values are reloaded from storage
   * when their scope changes.
   */
  addScopeDependency(scopeKey: string, dependentKey: string): void {
    let deps = this.scopeDependencies.get(scopeKey);
    if (!deps) {
      deps = new Set();
      this.scopeDependencies.set(scopeKey, deps);
    }
    deps.add(dependentKey);
  }

  /**
   * Get all keys that depend on a given scope key.
   */
  getScopeDependencies(scopeKey: string): string[] {
    return Array.from(this.scopeDependencies.get(scopeKey) ?? []);
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
    const factory = isFactory ? arg1 : (_ctx: any, _ext: any) => arg1;
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
    : never {
    for (const entry of graph.entries) {
      this.addEntry(entry);
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

    let mergedInput = input;
    if (this.storageAdapter && !options.skipStorage) {
      const storageValues = this.storageAdapter.getValues();
      mergedInput = { ...storageValues, ...input };
      this.storageAdapter.onBeforeEvaluate?.();
    } else if (options.skipStorage) {
      this.valueProvider = undefined;
    }

    // Include parent context keys as "changed" so dependent nodes are processed.
    // This is important for sub-graphs that depend on values from the parent.
    const parentKeys = Object.keys(parentCtx);
    const result = this._evaluate(mergedInput, parentKeys);

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
    return Object.keys(this._ctx).filter((k) => !this.computedNodes.has(k));
  }

  /** Get node keys defined by this graph */
  getOwnNodeKeys(): string[] {
    const keys: string[] = [];
    for (const entry of this.entries) {
      if (entry.kind === 'node') {
        keys.push(entry.key);
      }
    }
    return keys;
  }

  /** Get all computed keys defined by this graph */
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

  private _evaluate(inputValues: Partial<Ctx> = {}, additionalChangedKeys: string[] = []): Ctx {
    const log = this._debug ? console.log.bind(console) : () => {};
    const order = this.toposort();

    const changed = new Set<string>([...Object.keys(inputValues), ...additionalChangedKeys]);

    const keyToIndex = new Map<string, number>();
    for (let i = 0; i < order.length; i++) {
      const entry = order[i];
      if (entry.kind === 'node' || entry.kind === 'computed') {
        keyToIndex.set(entry.key, i);
      }
    }

    let currentIndex = 0;
    let iterations = 0;

    const effectSet = (key: string, value: unknown) => {
      const def = this.nodeDefs.get(key);
      if (!def) throw new Error(`Unknown node "${key}"`);
      const next = def.output.parse(value);
      if (!isEqual(this._ctx[key as keyof Ctx], next)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._ctx as any)[key] = next;
        changed.add(key);
        this.notifyNodeWatchers(key);
        const nodeIndex = keyToIndex.get(key);
        if (nodeIndex !== undefined && nodeIndex < currentIndex) {
          currentIndex = nodeIndex;
        }
      }
    };

    for (currentIndex = 0; currentIndex < order.length; currentIndex++) {
      if (++iterations > 1000) throw new Error('Effect loop detected');

      const entry = order[currentIndex];

      if (entry.kind === 'node') {
        // Process if: no deps, a dep changed, OR this node's value is being set directly
        const isDirectUpdate = entry.key in inputValues;
        // Check if any scope dependency changed (e.g., 'output' changed and this node is scoped by 'output')
        const isScopeDependencyChange = Array.from(this.scopeDependencies.entries()).some(
          ([scopeKey, dependentKeys]) => changed.has(scopeKey) && dependentKeys.has(entry.key)
        );
        const shouldProcess =
          isDirectUpdate ||
          isScopeDependencyChange ||
          entry.deps.length === 0 ||
          entry.deps.some((dep) => changed.has(dep));
        if (!shouldProcess) continue;

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
          continue;
        }

        let inputValue: unknown;
        if (entry.key in inputValues) {
          inputValue = inputValues[entry.key as keyof Ctx];
        } else if (this.valueProvider) {
          // Check valueProvider first - it may have scope-dependent values
          const providedValue = this.valueProvider(entry.key, this._ctx);
          if (providedValue !== undefined) {
            inputValue = providedValue;
          } else if (isScopeDependencyChange) {
            // Scope changed but no stored value exists - use default (don't reuse old scope's value)
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
          // If the input schema transform returned undefined, fall back to default
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
          // Mark as changed if value changed OR if this is a new key (even with undefined value)
          // This ensures dependent nodes are processed when a node is first added
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
        if (!shouldProcess) continue;

        const keyExists = entry.key in this._ctx;
        const next = entry.compute(this._ctx, this._ext);
        const valueChanged = !isEqual(this._ctx[entry.key as keyof Ctx], next);
        if (!keyExists || valueChanged) {
          (this._ctx as Record<string, unknown>)[entry.key] = next;
          // Mark as changed if value changed OR if this is a new key
          changed.add(entry.key);
          if (valueChanged) {
            this.notifyNodeWatchers(entry.key);
          }
        }
      } else if (entry.kind === 'discriminator') {
        const current = this.activeDiscriminators.get(entry.discriminatorKey);

        // If discriminator key hasn't changed but we have an active sub-graph,
        // forward input values and sync
        if (!changed.has(entry.discriminatorKey) && current) {
          this.evaluateAndSyncSubgraph(current.subGraph, inputValues, changed);
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const discriminatorValue = (this._ctx as any)[entry.discriminatorKey];
        const branches = entry.factory(this._ctx, this._ext);
        const targetBranch = discriminatorValue;
        const branchDef = targetBranch ? branches[targetBranch] : undefined;

        if (!branchDef) {
          if (current) {
            log(`  🔀 discriminator: no matching branch for "${targetBranch}", cleaning up`);
            this.cleanupSubgraphNodes(current.subGraph);
            this.activeDiscriminators.delete(entry.discriminatorKey);
          }
          continue;
        }

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

        const needsSwitch = !current || current.branch !== targetBranch;
        if (needsSwitch) {
          log(`  🔀 discriminator: switching to branch "${targetBranch}"`);

          if (current) {
            this.cleanupSubgraphNodes(current.subGraph);
          }

          const subGraph = branchGraph.clone();
          this.prepareSubgraph(subGraph);

          // Forward all input values to the subgraph - it will use what it needs
          // and forward the rest to its own nested discriminators
          subGraph.init(inputValues as Record<string, unknown>, this._ext, this._ctx, this._debug);
          this.syncSubgraph(subGraph, changed);

          this.activeDiscriminators.set(entry.discriminatorKey, {
            branch: targetBranch,
            subGraph,
          });
        } else if (current && (changed.size > 0 || Object.keys(inputValues).length > 0)) {
          this.evaluateAndSyncSubgraph(current.subGraph, inputValues, changed);
        }
      } else if (entry.kind === 'effect') {
        const depsChanged = entry.deps.some((dep) => changed.has(dep));
        if (!depsChanged) continue;

        entry.run(this._ctx, this._ext, effectSet);
      }
    }

    for (const callback of this.globalWatchers) callback();
    return this._ctx;
  }

  private toposort(): GraphEntry[] {
    const visited = new Set<GraphEntry>();
    const visiting = new Set<GraphEntry>();
    const result: GraphEntry[] = [];
    const nodeIndex = new Map<string, number>();
    this.entries.forEach((e, i) => {
      if (e.kind === 'node' || e.kind === 'computed') nodeIndex.set(e.key, i);
    });
    const visit = (entry: GraphEntry, entryIndex: number) => {
      if (visited.has(entry)) return;
      if (visiting.has(entry)) throw new Error('Cycle detected');
      visiting.add(entry);
      const deps = entry.kind === 'discriminator' ? [entry.discriminatorKey] : entry.deps;
      for (const dep of deps) {
        const depIdx = nodeIndex.get(dep);
        if (depIdx !== undefined && depIdx < entryIndex) visit(this.entries[depIdx], depIdx);
      }
      visiting.delete(entry);
      visited.add(entry);
      result.push(entry);
    };
    this.entries.forEach((entry, i) => visit(entry, i));
    return result;
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
