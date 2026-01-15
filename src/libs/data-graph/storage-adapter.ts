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
  /** Group name - used as part of storage key. Optional. */
  name?: string;
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
    // Track keys that are explicitly listed in named groups
    // These should be excluded from wildcard groups
    const explicitKeys = this.getExplicitKeys();

    for (const group of this.options.groups) {
      const storageKey = this.buildStorageKey(group.name, group.scope, allValues as Ctx);
      if (!storageKey) {
        continue;
      }

      const stored = this.options.storage.getItem(storageKey);
      if (stored) {
        try {
          const values = JSON.parse(stored);
          if (group.keys === '*') {
            // For wildcard groups, exclude keys that are explicitly defined in other groups
            for (const key of Object.keys(values)) {
              if (!explicitKeys.has(key)) {
                allValues[key] = values[key];
              }
            }
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

  /** Get all keys that are explicitly listed in named groups (non-wildcard) */
  private getExplicitKeys(): Set<string> {
    const keys = new Set<string>();
    for (const group of this.options.groups) {
      if (group.keys !== '*') {
        for (const key of group.keys) {
          keys.add(key);
        }
      }
    }
    return keys;
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
    const activeKeys = new Set(Object.keys(ctx));

    // Pre-compute keys claimed by conditional scoped groups whose conditions match.
    // These keys are excluded from unconditional groups but NOT from other conditional groups.
    const conditionalClaimedKeys = new Set<string>();
    for (const group of this.options.groups) {
      if (!group.condition || !group.scope) continue;
      if (!group.condition(ctx)) continue;
      if (group.keys === '*') continue;

      const storageKey = this.buildStorageKey(group.name, group.scope, ctx);
      if (!storageKey) continue;

      for (const key of group.keys) {
        if (activeKeys.has(key)) {
          conditionalClaimedKeys.add(key);
        }
      }
    }

    // Track keys claimed by unconditional groups (prevents duplicate saves)
    const unconditionalClaimedKeys = new Set<string>();

    for (const group of this.options.groups) {
      if (group.condition && !group.condition(ctx)) continue;

      const isConditionalScoped = group.condition && group.scope;

      let keysToSave: string[];
      if (group.keys === '*') {
        // Wildcard: exclude both conditional and unconditional claimed keys
        keysToSave = Array.from(activeKeys).filter(
          (k) => !conditionalClaimedKeys.has(k) && !unconditionalClaimedKeys.has(k)
        );
      } else if (isConditionalScoped) {
        // Conditional scoped: only exclude keys claimed by other unconditional groups
        keysToSave = group.keys.filter(
          (k) => activeKeys.has(k) && !unconditionalClaimedKeys.has(k)
        );
      } else {
        // Unconditional: exclude keys claimed by conditional groups and other unconditional groups
        keysToSave = group.keys.filter(
          (k) =>
            activeKeys.has(k) && !conditionalClaimedKeys.has(k) && !unconditionalClaimedKeys.has(k)
        );
      }

      const storageKey = this.buildStorageKey(group.name, group.scope, ctx);
      if (!storageKey) continue;

      // Only unconditional groups claim keys (conditional groups can overlap)
      if (!isConditionalScoped) {
        keysToSave.forEach((k) => unconditionalClaimedKeys.add(k));
      }

      // Start with existing values to retain keys from inactive nodes
      let values: Record<string, unknown> = {};
      const stored = this.options.storage.getItem(storageKey);
      if (stored) {
        try {
          values = JSON.parse(stored);
        } catch {
          // Invalid JSON, start fresh
        }
      }

      // For wildcard groups, remove any keys that are explicitly defined in named groups
      // This cleans up stale data when keys are moved to explicit groups
      if (group.keys === '*') {
        // Get all explicitly listed keys to remove from wildcard group storage
        const explicitKeys = this.getExplicitKeys();
        for (const key of explicitKeys) {
          delete values[key];
        }
      }

      // Overwrite with current context values
      for (const key of keysToSave) {
        values[key] = ctx[key as keyof Ctx];
      }

      // Only save if we have values to save
      if (Object.keys(values).length > 0) {
        this.options.storage.setItem(storageKey, JSON.stringify(values));
      }
    }
  }

  clear(): void {
    const ctx = this.graph.ctx;

    for (const group of this.options.groups) {
      const storageKey = this.buildStorageKey(group.name, group.scope, ctx);
      if (storageKey) {
        this.options.storage.removeItem(storageKey);
      }
    }
  }

  getStorageKeys(): string[] {
    const ctx = this.graph.ctx;
    const keys: string[] = [];

    for (const group of this.options.groups) {
      const storageKey = this.buildStorageKey(group.name, group.scope, ctx);
      if (storageKey && !keys.includes(storageKey)) {
        keys.push(storageKey);
      }
    }

    return keys;
  }

  private setupValueProvider(): void {
    const hasScopedGroups = this.options.groups.some((g) => g.scope);
    if (!hasScopedGroups) return;

    // Get all explicitly listed keys (from any named group, not just scoped ones)
    // These should be excluded from wildcard groups
    const explicitKeys = this.getExplicitKeys();

    // Register scope dependencies with the graph
    // When a scope key changes, dependent keys will be re-evaluated
    this.registerScopeDependencies();

    this.graph.setValueProvider((key, ctx) => {
      // First, check conditional scoped groups (highest priority when condition matches)
      for (const group of this.options.groups) {
        if (!group.scope || !group.condition) continue;

        if (group.keys === '*') {
          if (explicitKeys.has(key)) continue;
        } else {
          if (!group.keys.includes(key)) continue;
        }

        if (!group.condition(ctx)) continue;

        const storageKey = this.buildStorageKey(group.name, group.scope, ctx);
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

      // Then check unconditional scoped groups
      for (const group of this.options.groups) {
        if (!group.scope || group.condition) continue;

        if (group.keys === '*') {
          if (explicitKeys.has(key)) continue;
        } else {
          if (!group.keys.includes(key)) continue;
        }

        const storageKey = this.buildStorageKey(group.name, group.scope, ctx);
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

      // Finally, fall back to unscoped groups for keys that exist in conditional scoped groups
      // but whose condition doesn't currently match
      for (const group of this.options.groups) {
        if (group.scope) continue; // Only check unscoped groups

        if (group.keys === '*') {
          if (explicitKeys.has(key)) continue;
        } else {
          if (!group.keys.includes(key)) continue;
        }

        const storageKey = this.buildStorageKey(group.name, undefined, ctx);
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

    // Group name comes before scope values: prefix.groupName.scopeValue
    if (groupName) {
      parts.push(groupName);
    }

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
