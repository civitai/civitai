import type { DataGraph, StorageAdapter } from './data-graph';

// ============================================================================
// Types
// ============================================================================

/** Storage backend interface - defaults to localStorage */
export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Base properties shared by all storage groups */
interface BaseStorageGroup {
  /**
   * Scope key(s) to create hierarchical storage paths.
   * Supports dot-notation for nested properties (e.g., 'model.id').
   */
  scope?: string | string[];
  /**
   * Condition to determine if this group should be saved/loaded.
   * If the condition returns false, keys fall through to later groups.
   */
  condition?: (ctx: Record<string, unknown>) => boolean;
}

/** Named group with explicit keys */
export interface NamedStorageGroup extends BaseStorageGroup {
  /** Group name - used as part of storage key. Optional when using scope. */
  name?: string;
  /** Node keys to include in this group */
  keys: string[];
}

/** Catch-all group for remaining keys */
export interface CatchAllStorageGroup extends BaseStorageGroup {
  /** Use '*' to catch all ungrouped keys */
  keys: '*';
}

export type StorageGroup = NamedStorageGroup | CatchAllStorageGroup;

export interface LocalStorageAdapterOptions {
  /** Prefix for all storage keys */
  prefix: string;
  /** Storage groups configuration */
  groups: StorageGroup[];
  /** Storage backend (defaults to localStorage) */
  storage?: StorageBackend;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a dot-notation path from an object.
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Create an in-memory storage backend (useful for SSR or testing)
 */
export function createMemoryStorage(): StorageBackend {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
}

// ============================================================================
// LocalStorageAdapter
// ============================================================================

class LocalStorageAdapter<Ctx extends Record<string, unknown>> implements StorageAdapter<Ctx> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private graph!: DataGraph<Ctx, any, any>;
  private options: Required<LocalStorageAdapterOptions>;
  // Track which graph instances have been initialized (by their createdAt timestamp)
  private initializedGraphs = new Set<number>();

  constructor(options: LocalStorageAdapterOptions) {
    this.options = {
      storage: typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage(),
      ...options,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attach(graph: DataGraph<Ctx, any, any>): void {
    this.graph = graph;
  }

  /** Check if the current graph has been initialized */
  private isInitialized(): boolean {
    return this.initializedGraphs.has(this.graph.createdAt);
  }

  /** Mark the current graph as initialized */
  private markInitialized(): void {
    this.initializedGraphs.add(this.graph.createdAt);
  }

  onSet(_values: Partial<Ctx>, _ctx: Ctx): void {
    this.save();
  }

  getValues(): Partial<Ctx> {
    if (this.isInitialized()) {
      return {};
    }

    const allValues: Record<string, unknown> = {};

    for (const group of this.options.groups) {
      const storageKey = this.buildStorageKey(
        group.keys === '*' ? undefined : group.name,
        group.scope,
        allValues as Ctx
      );
      if (!storageKey) {
        continue;
      }

      const stored = this.options.storage.getItem(storageKey);
      if (stored) {
        try {
          const values = JSON.parse(stored);
          if (group.keys === '*') {
            Object.assign(allValues, values);
          } else {
            for (const key of group.keys) {
              if (key in values) {
                allValues[key] = values[key];
              }
            }
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }

    return allValues as Partial<Ctx>;
  }

  onBeforeEvaluate(): void {
    this.setupValueProvider();
  }

  onInit(): void {
    if (this.isInitialized()) {
      return;
    }
    this.markInitialized();
  }

  save(): void {
    const ctx = this.graph.ctx;
    const claimedKeys = new Set<string>();
    const activeKeys = new Set(Object.keys(ctx));

    for (const group of this.options.groups) {
      if (group.condition && !group.condition(ctx)) continue;

      let keysToSave: string[];
      if (group.keys === '*') {
        keysToSave = Array.from(activeKeys).filter((k) => !claimedKeys.has(k));
      } else {
        keysToSave = group.keys.filter((k) => activeKeys.has(k) && !claimedKeys.has(k));
      }

      if (keysToSave.length === 0) continue;

      const storageKey = this.buildStorageKey(
        group.keys === '*' ? undefined : group.name,
        group.scope,
        ctx
      );
      if (!storageKey) continue;

      keysToSave.forEach((k) => claimedKeys.add(k));

      const values: Record<string, unknown> = {};
      for (const key of keysToSave) {
        values[key] = ctx[key as keyof Ctx];
      }

      this.options.storage.setItem(storageKey, JSON.stringify(values));
    }
  }

  clear(): void {
    const ctx = this.graph.ctx;

    for (const group of this.options.groups) {
      const storageKey = this.buildStorageKey(
        group.keys === '*' ? undefined : group.name,
        group.scope,
        ctx
      );
      if (storageKey) {
        this.options.storage.removeItem(storageKey);
      }
    }
  }

  getStorageKeys(): string[] {
    const ctx = this.graph.ctx;
    const keys: string[] = [];

    for (const group of this.options.groups) {
      const storageKey = this.buildStorageKey(
        group.keys === '*' ? undefined : group.name,
        group.scope,
        ctx
      );
      if (storageKey && !keys.includes(storageKey)) {
        keys.push(storageKey);
      }
    }

    return keys;
  }

  private setupValueProvider(): void {
    const hasScopedGroups = this.options.groups.some((g) => g.scope);
    if (!hasScopedGroups) return;

    const namedScopedKeys = new Set<string>();
    for (const group of this.options.groups) {
      if (group.scope && group.keys !== '*') {
        group.keys.forEach((k) => namedScopedKeys.add(k));
      }
    }

    // Register scope dependencies with the graph
    // When a scope key changes, dependent keys will be re-evaluated
    this.registerScopeDependencies();

    this.graph.setValueProvider((key, ctx) => {
      for (const group of this.options.groups) {
        if (!group.scope) continue;

        if (group.keys === '*') {
          if (namedScopedKeys.has(key)) continue;
        } else {
          if (!group.keys.includes(key)) continue;
        }

        if (group.condition && !group.condition(ctx)) continue;

        const storageKey = this.buildStorageKey(
          group.keys === '*' ? undefined : group.name,
          group.scope,
          ctx
        );
        if (!storageKey) continue;
        const stored = this.options.storage.getItem(storageKey);
        if (stored) {
          try {
            const values = JSON.parse(stored);
            if (key in values) {
              return values[key];
            }
          } catch {
            // Invalid JSON, skip
          }
        }
      }

      return undefined;
    });
  }

  /**
   * Register scope dependencies with the graph.
   * For each scoped group, register that when the scope key(s) change,
   * the dependent keys should be re-evaluated.
   */
  private registerScopeDependencies(): void {
    for (const group of this.options.groups) {
      if (!group.scope) continue;

      const scopeKeys = Array.isArray(group.scope) ? group.scope : [group.scope];
      const dependentKeys = group.keys === '*' ? [] : group.keys;

      // For named groups (non-wildcard), register each dependent key
      if (group.keys !== '*') {
        for (const scopeKey of scopeKeys) {
          // Extract the root key from dot-notation paths (e.g., 'model.id' -> 'model')
          const rootScopeKey = scopeKey.split('.')[0];
          for (const dependentKey of dependentKeys) {
            this.graph.addScopeDependency(rootScopeKey, dependentKey);
          }
        }
      }
      // Note: Wildcard groups ('*') will be handled dynamically by the valueProvider
      // since we don't know all possible keys at registration time
    }
  }

  private buildStorageKey(
    groupName: string | undefined,
    scope: string | string[] | undefined,
    ctx: Record<string, unknown>
  ): string | null {
    const parts = [this.options.prefix];

    if (scope) {
      const scopeKeys = Array.isArray(scope) ? scope : [scope];
      for (const scopeKey of scopeKeys) {
        const value = getByPath(ctx, scopeKey);
        if (value !== undefined && value !== null) {
          parts.push(String(value));
        } else {
          return null;
        }
      }
    }

    if (groupName) {
      parts.push(groupName);
    }

    return parts.join('.');
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a localStorage adapter for DataGraph v2.
 */
export function createLocalStorageAdapter<Ctx extends Record<string, unknown>>(
  options: LocalStorageAdapterOptions
): StorageAdapter<Ctx> {
  return new LocalStorageAdapter<Ctx>(options);
}
