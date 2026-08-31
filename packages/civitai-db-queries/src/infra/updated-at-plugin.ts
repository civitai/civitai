import {
  AliasNode,
  ColumnNode,
  ColumnUpdateNode,
  OperationNodeTransformer,
  ReferenceNode,
  sql,
  ValueNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type TableNode,
  type UnknownRow,
  type UpdateQueryNode,
} from 'kysely';

// Auto-stamp `updatedAt = <now>` on every UPDATE against a table that has a Prisma `@updatedAt` column.
//
// Prisma bumped `@updatedAt` client-side on every write; Kysely does not, and there is no DB trigger — so a
// naive port silently stops bumping `updatedAt` (the correctness gotcha flagged in the plan). This plugin makes
// that correct globally, so query functions can just write their columns and never think about `updatedAt`.
// The set of `@updatedAt` tables is generated from `schema.prisma` and injected here, keeping the plugin
// schema-agnostic. An UPDATE that sets `updatedAt` explicitly is left untouched.
//
// Scope: UPDATE only. INSERTs already set `updatedAt` explicitly where required (or the column carries a
// `@default(now())`), so they need no rewrite.
class UpdatedAtTransformer extends OperationNodeTransformer {
  constructor(private readonly tables: ReadonlySet<string>) {
    super();
  }

  protected override transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
    const transformed = super.transformUpdateQuery(node);
    const table = tableNameOf(transformed.table);
    if (!table || !this.tables.has(table)) return transformed;
    if (setsColumn(transformed.updates, 'updatedAt')) return transformed;

    const stamp = ColumnUpdateNode.create(
      ColumnNode.create('updatedAt'),
      ValueNode.create(new Date())
    );
    return { ...transformed, updates: [...(transformed.updates ?? []), stamp] };
  }
}

// The target table of an UPDATE. A plain `updateTable('X')` compiles to a TableNode; `updateTable('X as x')`
// wraps it in an AliasNode — unwrap that so an aliased target on an `@updatedAt` table is still recognized
// (otherwise the plugin would silently skip the stamp). Undefined for anything else we don't touch.
function tableNameOf(node: UpdateQueryNode['table']): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'TableNode') return (node as TableNode).table.identifier.name;
  if (AliasNode.is(node)) return tableNameOf((node as AliasNode).node as UpdateQueryNode['table']);
  return undefined;
}

function setsColumn(updates: UpdateQueryNode['updates'], name: string): boolean {
  return (updates ?? []).some((u) => updatedColumnName(u.column) === name);
}

// The column name a ColumnUpdateNode targets. The object form (`.set({ updatedAt })`) stores a ColumnNode; the
// chained single-column form (`.set('updatedAt', value)`) stores a ReferenceNode wrapping a ColumnNode. Both
// must be recognized, else the plugin fails to see an explicit `updatedAt` and double-stamps it.
function updatedColumnName(column: OperationNode): string | undefined {
  if (ColumnNode.is(column)) return column.column.name;
  if (ReferenceNode.is(column) && ColumnNode.is(column.column)) return column.column.column.name;
  return undefined;
}

// Opt out of the auto-stamp for a single write that must NOT bump `updatedAt` — set the column to itself
// (`updatedAt = "updatedAt"`) in one atomic statement. The plugin sees an explicit `updatedAt` and adds
// nothing, so the row's timestamp is preserved without a prior read or `db.withoutPlugins()`. Use this only
// where the Prisma source deliberately dodged `@updatedAt` with raw SQL (e.g. a scan/ingestion recompute or
// a moderation unpublish that must not reorder "Recently Updated"). A raw-`sql` UPDATE needs nothing — the
// plugin never rewrites those.
// Typed `Date` (not the default `unknown`) so it's assignable to any `updatedAt` column's update position —
// a module-level const gets no contextual type to narrow a bare `sql` fragment, and `@updatedAt` columns are
// always timestamps.
export const keepUpdatedAt = sql<Date>`"updatedAt"`;

export function updatedAtPlugin(updatedAtTables: ReadonlySet<string>): KyselyPlugin {
  const transformer = new UpdatedAtTransformer(updatedAtTables);
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      return transformer.transformNode(args.node);
    },
    transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return Promise.resolve(args.result);
    },
  };
}
