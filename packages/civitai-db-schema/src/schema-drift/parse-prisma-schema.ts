import type {
  ParsedField,
  ParsedModel,
  ParsedRelation,
  ParsedSchema,
  ParsedUnique,
  ReferentialAction,
} from './types';
import { REFERENTIAL_ACTIONS } from './types';

/**
 * Prisma's scalar types. A field typed as anything else is a model reference or an enum;
 * those have no direct nullability contract we can check against a column, so the
 * nullability comparison is restricted to this set.
 */
const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
]);

const MODEL_BLOCK = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
const MODEL_MAP = /@@map\(\s*"([^"]+)"\s*\)/;
const FIELD_MAP = /@map\(\s*"([^"]+)"\s*\)/;
const MODEL_IGNORE = /@@ignore\b/;
const BLOCK_UNIQUE = /@@unique\(\s*(?:fields:\s*)?\[([^\]]*)\]/g;
/**
 * Owning-side relation. The optional leading `"name"` is the relation name used to
 * disambiguate multiple relations to the same model (`@relation("ChallengeEventCover", ...)`).
 * The back-reference side has no `fields:`/`references:` and so never matches — which is
 * exactly the filter we want, since only the owning side maps to a foreign key.
 */
const RELATION =
  /@relation\(\s*(?:"[^"]*"\s*,\s*)?fields:\s*\[([^\]]*)\]\s*,\s*references:\s*\[([^\]]*)\]([^)]*)\)/;
const FIELD_UNIQUE = /(?:^|[\s)])@unique\b/;

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAction(tail: string, key: 'onDelete' | 'onUpdate'): ReferentialAction | null {
  const m = new RegExp(`${key}:\\s*(\\w+)`).exec(tail);
  if (!m) return null;
  const value = m[1] as ReferentialAction;
  if (!REFERENTIAL_ACTIONS.includes(value)) {
    throw new Error(`Unrecognised Prisma referential action "${m[1]}" for ${key}`);
  }
  return value;
}

/**
 * Prisma's implicit `onDelete`.
 *
 * Optional relation -> `SetNull`; required relation -> `Restrict`. NOT `Cascade`.
 * https://www.prisma.io/docs/orm/prisma-schema/data-model/relations/referential-actions
 */
export function defaultOnDelete(optional: boolean): ReferentialAction {
  return optional ? 'SetNull' : 'Restrict';
}

/** Prisma's implicit `onUpdate` is `Cascade` for optional and required relations alike. */
export function defaultOnUpdate(): ReferentialAction {
  return 'Cascade';
}

/**
 * Parse a Prisma schema into the subset of facts the drift check needs.
 *
 * This is a targeted line reader, not a full Prisma grammar: it understands model blocks,
 * field declarations, `@map`/`@@map`, `@@ignore`, `@unique`/`@@unique` and owning-side
 * `@relation`. Anything else in the schema is ignored by design.
 */
export function parsePrismaSchema(source: string): ParsedSchema {
  const models: ParsedModel[] = [];

  // Reset lastIndex: MODEL_BLOCK is module-scoped and /g-flagged.
  MODEL_BLOCK.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = MODEL_BLOCK.exec(source)) !== null) {
    const name = block[1];
    const body = block[2];

    const mapped = MODEL_MAP.exec(body);
    const table = mapped ? mapped[1] : name;
    const ignored = MODEL_IGNORE.test(body);

    const fields: ParsedField[] = [];
    const uniques: ParsedUnique[] = [];
    const relations: ParsedRelation[] = [];

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('@@')) continue; // block attributes handled below

      const tokens = line.split(/\s+/);
      if (tokens.length < 2) continue;
      const fieldName = tokens[0];
      const rawType = tokens[1];
      if (!/^[A-Za-z_]\w*$/.test(fieldName)) continue;

      const list = rawType.endsWith('[]');
      const optional = rawType.endsWith('?');
      const type = rawType.replace(/[?[\]]+$/, '');
      if (!/^[A-Za-z_]\w*$/.test(type)) continue;

      const columnMatch = FIELD_MAP.exec(line);
      fields.push({
        name: fieldName,
        column: columnMatch ? columnMatch[1] : fieldName,
        type,
        optional,
        list,
        scalar: SCALAR_TYPES.has(type),
        unique: FIELD_UNIQUE.test(line),
      });

      const relation = RELATION.exec(line);
      if (relation) {
        const tail = relation[3] ?? '';
        const onDelete = parseAction(tail, 'onDelete');
        const onUpdate = parseAction(tail, 'onUpdate');
        relations.push({
          model: name,
          field: fieldName,
          targetModel: type,
          fields: splitList(relation[1]),
          references: splitList(relation[2]),
          onDelete: onDelete ?? defaultOnDelete(optional),
          onUpdate: onUpdate ?? defaultOnUpdate(),
          onDeleteExplicit: onDelete !== null,
          onUpdateExplicit: onUpdate !== null,
          optional,
        });
      }
    }

    for (const field of fields) {
      if (field.unique && !field.list) uniques.push({ fields: [field.name], source: '@unique' });
    }

    BLOCK_UNIQUE.lastIndex = 0;
    let unique: RegExpExecArray | null;
    while ((unique = BLOCK_UNIQUE.exec(body)) !== null) {
      uniques.push({ fields: splitList(unique[1]), source: '@@unique' });
    }

    models.push({ name, table, ignored, fields, uniques, relations });
  }

  return { models };
}
