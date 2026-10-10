import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../../test/source-scan';
import { stripComments } from '../../../../../test/strip-comments';

/**
 * Seam guard for the server-owned `Image.metadata` provenance keys
 * (`~/shared/utils/block-provenance-metadata`).
 *
 * The behaviour suite (`image-block-provenance-metadata.test.ts`) proves `createImage`,
 * the entity writers and the input schemas drop the keys. This pins two POPULATIONS — every
 * production site that inserts an `Image` row, and every production site that updates an
 * `Image` row in a way that can change `metadata` — what each does about `metadata`, and
 * the closed set of sites allowed to write a provenance key. Each table fails when it
 * grows or shrinks, so a writer of a shape listed below has to be classified here before
 * it ships.
 *
 * Insert population, under `src/` with test files excluded: every
 * `.image.(create|createMany|createManyAndReturn|upsert)(` call, every raw
 * `INSERT INTO "Image"`, and every nested `create`/`createMany`/`connectOrCreate`/`upsert`
 * under a relation field typed `Image` in the Prisma schema — found either within 300
 * characters of the field's key in the same statement, or through a value built away from
 * it (`field: x`, `field: cond ? x : …`, `field: build(…)`, shorthand `{ field }`) that
 * resolves, ONE HOP and in the SAME FILE, to an object literal holding that nested key: a
 * variable defined as that literal, or as a call to a function returning it, or such a
 * call itself.
 *
 * Update population, same files: every `.image.(update|updateMany|updateManyAndReturn)(`
 * call, every raw `UPDATE "Image"`, and every nested `update`/`updateMany` found the two
 * ways above — filtered to the sites that can change `metadata`: the written data names
 * `metadata`, or is something this file cannot read (a non-literal `data`, a top-level
 * spread or computed key, a raw SET clause that opens with an interpolated fragment). A
 * `where` that only reads `metadata` does not enter. `.image.upsert` is in the insert
 * population, whose decision covers its whole argument, `update` branch included.
 *
 * NOT covered: a nested write built more than one hop away (a helper that returns a
 * variable rather than a literal, a helper or variable in another file); raw SQL
 * assembled outside a single template literal (a SET clause held in a variable IS caught,
 * as an interpolated fragment); a `metadata` column write spelled without the text
 * `metadata`.
 *
 * The write-site and provenance-key ledgers count sites per enclosing function; the
 * stamper ledger records which functions name `blockProvenance` at all. The enclosing
 * function is the nearest `function` or `const x = async` declaration before the site; a
 * site in a plain arrow is attributed to the declaration above it.
 */

const ROOT = process.cwd();

type Decision =
  /** `createImage` itself: strips client keys, writes only `blockProvenance`. */
  | 'createImage-strip'
  /** Spreads caller input, and overrides `metadata` with a stripped copy. */
  | 'in-function-strip'
  /** Writes no `metadata` column and spreads nothing into the row. */
  | 'no-metadata'
  /** Builds `metadata` from server values only; no provenance key. */
  | 'server-literal'
  /** `INSERT … SELECT` copying an existing row's stored metadata. */
  | 'copied-from-stored-row'
  /** Nested relation create; `metadata` after the last spread is a stripped copy. */
  | 'nested-strip'
  /** Nested relation create; `metadata` after the last spread is a server-built literal. */
  | 'nested-server-literal';

/** Every insert site, keyed by enclosing function, with its decision and its site count. */
const WRITE_SITE_LEDGER: Record<string, { decision: Decision; sites: number }> = {
  'src/server/services/image.service.ts#createImage': { decision: 'createImage-strip', sites: 1 },
  'src/server/services/image-entity.service.ts#createEntityImages': {
    decision: 'in-function-strip',
    sites: 1,
  },
  'src/server/services/image-entity.service.ts#updateEntityImages': {
    decision: 'in-function-strip',
    sites: 1,
  },
  'src/server/services/article.service.ts#linkArticleContentImages': {
    decision: 'no-metadata',
    sites: 1,
  },
  'src/pages/api/admin/temp/migrate-article-images.ts#processBatch': {
    decision: 'no-metadata',
    sites: 1,
  },
  'src/server/services/blocks/app-listing-assets.service.ts#createStoredImage': {
    decision: 'server-literal',
    sites: 1,
  },
  // The source row's metadata was itself written through one of the sites above.
  'src/server/jobs/daily-challenge-processing.ts#duplicateImage': {
    decision: 'copied-from-stored-row',
    sites: 1,
  },
  'src/server/controllers/user.controller.ts#updateUserHandler': {
    decision: 'nested-strip',
    sites: 1,
  },
  'src/server/services/collection.service.ts#upsertCollection': {
    decision: 'nested-strip',
    sites: 1,
  },
  'src/server/services/user-profile.service.ts#updateUserProfile': {
    decision: 'nested-server-literal',
    sites: 1,
  },
};

/**
 * The set of functions that may name `blockProvenance`: `createImage`, which declares it,
 * and the callers that pass it — the only legitimate stampers. Membership, not a mention
 * count, so refactoring inside a listed function does not churn this list.
 */
const STAMPER_FUNCTIONS: string[] = [
  'src/server/services/blocks/block-image-upload.service.ts#persistBlockWorkflowOutputImage',
  'src/server/services/image.service.ts#createImage',
];

/**
 * Every site that writes a provenance key as an object key. `createImage` is the one
 * `Image` writer; the other entry stamps `Post.metadata`, a different column.
 */
const PROVENANCE_KEY_WRITE_LEDGER: Record<string, number> = {
  'src/server/services/image.service.ts#createImage': 1,
  'src/server/services/blocks/block-post.service.ts#writeBlockPost': 1,
};

const WRITE_CALL = /\.image\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\s*\(/g;
const RAW_INSERT = /INSERT\s+INTO\s+(?:"?public"?\.)?"Image"/gi;

/** Relation fields of type `Image` (or `Image?` / `Image[]`) on any Prisma model. */
const IMAGE_RELATION_FIELDS = [
  ...new Set(
    [
      ...readFileSync(
        join(ROOT, 'packages/civitai-db-schema/prisma/schema.full.prisma'),
        'utf8'
      ).matchAll(/^[ \t]+(\w+)[ \t]+Image(?:\?|\[\])?[ \t\r\n]/gm),
    ].map((m) => m[1])
  ),
].sort();
const NESTED_CREATE = new RegExp(
  String.raw`\b(?:${IMAGE_RELATION_FIELDS.join(
    '|'
  )})\s*:[^;]{0,300}?\b(?:create|createMany|connectOrCreate|upsert)\s*:`,
  'g'
);
const UPDATE_CALL = /\.image\s*\.\s*(?:update|updateMany|updateManyAndReturn)\s*\(/g;
const RAW_UPDATE = /UPDATE\s+(?:"?public"?\.)?"Image"/gi;
const NESTED_UPDATE = new RegExp(
  String.raw`\b(?:${IMAGE_RELATION_FIELDS.join('|')})\s*:[^;]{0,300}?\b(?:update|updateMany)\s*:`,
  'g'
);
const STAMPER = /\bblockProvenance\b/g;
const PROVENANCE_KEY_WRITE = new RegExp(
  [
    // `{ [KEY]: v }` and `m[KEY] = v`
    String.raw`\[\s*(?:BLOCK_\w*APP_ID_META_KEY|blockProvenance\.key)\s*\]\s*(?::|=(?!=))`,
    // `{ ['blockXAppId']: v }` and `m['blockXAppId'] = v`
    String.raw`\[\s*['"]block[A-Z]\w*AppId['"]\s*\]\s*(?::|=(?!=))`,
    // `{ blockXAppId: v }`, `{ 'blockXAppId': v }`
    String.raw`(?:^|[{,\s])['"]?block[A-Z]\w*AppId['"]?\s*:`,
    // shorthand `{ ...m, blockXAppId }` (a destructuring `{ blockXAppId } =` is a read)
    String.raw`[{,]\s*block[A-Z]\w*AppId\s*(?=,|\}(?!\s*=))`,
    // `m.blockXAppId = v`
    String.raw`\.block[A-Z]\w*AppId\s*=(?!=)`,
    // SQL `jsonb_build_object(…, 'blockXAppId', …)` and `jsonb_set(…, '{blockXAppId}', …)`
    String.raw`jsonb_build_object\([\s\S]{0,300}?'block[A-Z]\w*AppId'`,
    String.raw`'\{block[A-Z]\w*AppId\}'`,
  ].join('|'),
  'gm'
);
const PROVENANCE_TOKEN = /BLOCK_\w*APP_ID_META_KEY|\bblock[A-Z]\w*AppId\b|blockProvenance/;

const DECLARATION =
  /(?:\bfunction\s*\*?\s*(\w+)\s*[<(])|(?:\b(?:const|let)\s+(\w+)\s*=\s*async\b)/g;

/** The closest function declaration before `offset`. */
function enclosingFunction(text: string, offset: number): { name: string; start: number } {
  let found = { name: '<module>', start: 0 };
  for (const m of text.matchAll(DECLARATION)) {
    if (m.index === undefined || m.index >= offset) break;
    found = { name: m[1] ?? m[2], start: m.index };
  }
  return found;
}

/** Index of the backtick closing the template whose body contains `i`. */
function templateEnd(text: string, i: number): number {
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '`') return i;
    else if (text[i] === '$' && text[i + 1] === '{') i = interpolationEnd(text, i + 2);
    else i++;
  }
  return text.length;
}

function interpolationEnd(text: string, i: number): number {
  let depth = 1;
  while (i < text.length) {
    if (text[i] === '`') i = templateEnd(text, i + 1) + 1;
    else if (text[i] === '{' && ++depth) i++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
    else i++;
  }
  return text.length;
}

/** The raw statement from `offset` to the end of the template literal it sits in. */
function rawStatement(text: string, offset: number): string {
  return text.slice(offset, templateEnd(text, offset));
}

/** The `{ … }` object literal that starts at the first `{` at or after `from`. */
function objectAfter(text: string, from: number): string {
  const open = text.indexOf('{', from);
  // `create: data` is not a literal this file can read; an empty region fails every nested check.
  if (open === -1 || text.slice(from, open).trim() !== '') return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/**
 * The value assigned to `metadata:` after the last spread in `region` (a spread of
 * `stripBlockProvenanceMetadata(…)` is part of that value, not a competing one), or
 * null when a later spread could replace it.
 */
function metadataAfterLastSpread(region: string): string | null {
  const spreads = [...region.matchAll(/\.\.\.(?!stripBlockProvenanceMetadata\()[\w(]/g)];
  const lastSpread = spreads.length ? spreads[spreads.length - 1].index! : -1;
  const assignments = [...region.matchAll(/\bmetadata:\s*/g)].filter((m) => m.index! > lastSpread);
  const last = assignments[assignments.length - 1];
  return last ? region.slice(last.index! + last[0].length) : null;
}

/** The text between the `(` at `open` and its matching `)`. */
function argumentRegion(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unbalanced call at ${open}`);
}

type Site = { key: string; region: string; body: string };

/** Sites in one file's comment-stripped text matching `re`, keyed by enclosing function. */
function sitesIn(file: string, text: string, re: RegExp): Site[] {
  return [...text.matchAll(re)].map((m) => {
    const offset = m.index ?? 0;
    const fn = enclosingFunction(text, offset);
    const open = text.indexOf('(', offset + m[0].length - 1);
    return {
      key: `${file}#${fn.name}`,
      region:
        re === WRITE_CALL || re === UPDATE_CALL
          ? argumentRegion(text, open)
          : re === RAW_INSERT || re === RAW_UPDATE
          ? rawStatement(text, offset)
          : re === NESTED_CREATE || re === NESTED_UPDATE
          ? objectAfter(text, offset + m[0].length)
          : text.slice(offset, offset + 600),
      body: text.slice(fn.start, offset + 2000),
    };
  });
}

/** Any spread other than `...(cond ? { … } : {})`, whose branches are object literals. */
const UNSAFE_SPREAD = /\.\.\.(?!\(\s*[\w.!]+\s*\?\s*\{[^}]*\}\s*:\s*\{\s*\}\s*\))/;

/** Does this write site's shape match its recorded decision? Returns a reason when not. */
function checkDecision(decision: Decision, site: Site): string | null {
  const { region, body } = site;
  switch (decision) {
    case 'createImage-strip':
      if (!/const metadata = stripBlockProvenanceMetadata\(image\.metadata\)/.test(body))
        return 'createImage no longer strips image.metadata';
      if (
        // The row's only spread is the client-column helper; `metadata` follows it (after any
        // plain `column: value` entries), so the stripped copy plus the stamp is what lands.
        !/\.\.\.pickClientImageColumns\(image\),(?:\s*\w+:\s*[\w.]+,)*\s*metadata:\s*blockProvenance\s*\?\s*\{\s*\.\.\.metadata,\s*\[blockProvenance\.key\]:\s*blockProvenance\.appId\s*\}\s*:\s*metadata,/.test(
          region
        )
      )
        return 'createImage no longer writes the stripped metadata plus blockProvenance';
      return null;
    case 'in-function-strip':
      if (
        !/^stripBlockProvenanceMetadata\(image\.metadata\)/.test(
          metadataAfterLastSpread(region) ?? ''
        )
      )
        return 'spreads input without overriding metadata with a stripped copy';
      return null;
    case 'no-metadata':
      if (/\bmetadata\b/.test(region)) return 'now writes metadata';
      if (UNSAFE_SPREAD.test(region)) return 'now spreads a value into the row';
      return null;
    case 'server-literal':
      if (PROVENANCE_TOKEN.test(region)) return 'writes a provenance key';
      if (!/\bmetadata:\s*\{/.test(region)) return 'metadata is not an object literal';
      if (UNSAFE_SPREAD.test(region)) return 'spreads a value into the row';
      return null;
    case 'copied-from-stored-row':
      if (!/^INSERT INTO "Image"[\s\S]*SELECT[\s\S]*FROM "Image" i\s+WHERE i\.id = /.test(region))
        return 'is no longer an INSERT … SELECT from an existing Image row';
      return null;
    case 'nested-strip': {
      const value = metadataAfterLastSpread(region);
      if (!value || !/^(?:\{\s*\.\.\.)?stripBlockProvenanceMetadata\(/.test(value))
        return 'nested create no longer strips the input metadata';
      return null;
    }
    case 'nested-server-literal': {
      const value = metadataAfterLastSpread(region);
      if (!value || !value.startsWith('{')) return 'metadata is not a literal after the spreads';
      const literal = objectAfter(value, 0);
      if (PROVENANCE_TOKEN.test(literal)) return 'metadata literal names a provenance key';
      return null;
    }
  }
}

/**
 * An Image relation field whose value is an identifier or a call — `field: x`,
 * `field: cond ? x : …`, `field: build(…)`, or shorthand `{ field }` — so the nested write
 * is built away from the call site. Groups: 1 the name, 2 `(` when it is a call, 3 the
 * shorthand name.
 */
const RELATION_VALUE = new RegExp(
  String.raw`\b(?:${IMAGE_RELATION_FIELDS.join(
    '|'
  )})\s*:\s*(?:[\w.!]+\s*\?\s*)?(?:await\s+)?([A-Za-z_$][\w$]*)\s*(\(|(?=[,}\n:]))|[{,]\s*(${IMAGE_RELATION_FIELDS.join(
    '|'
  )})\s*(?=[,}])`,
  'g'
);
const escapeRe = (s: string) => s.replace(/[$.]/g, '\\$&');

const NESTED_KEYS = {
  create: /\b(?:create|createMany|connectOrCreate|upsert)\s*:/,
  update: /\b(?:update|updateMany)\s*:/,
} as const;

/** The object literal a same-file function returns (`return { … }` or `=> ({ … })`), or ''. */
function returnedLiteral(text: string, fname: string): string {
  const decl = new RegExp(
    String.raw`\bfunction\s*\*?\s*${escapeRe(fname)}\s*[<(]|\b(?:const|let)\s+${escapeRe(
      fname
    )}\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]{0,100})?=>`
  ).exec(text);
  if (!decl) return '';
  // Search only the declaration's own body: from its signature to the brace closing the
  // first `{` after it (for `=> ({ … })` that brace is the literal itself).
  // A `function` signature's parameters may destructure (`{ a }`): start after them.
  const from = decl[0].endsWith('(')
    ? decl.index + decl[0].length + argumentRegion(text, decl.index + decl[0].length - 1).length + 1
    : decl.index + decl[0].length;
  const open = text.indexOf('{', from);
  if (open === -1) return '';
  const body = text.slice(from, open + objectAfter(text, open).length);
  const ret = /\breturn\s*(?=\{)|=>\s*\(\s*(?=\{)|^\s*\(\s*(?=\{)/.exec(body);
  return ret ? objectAfter(body, ret.index + ret[0].length) : '';
}

/** The object literal a relation value resolves to inside `text`, following one hop. */
function relationLiteral(text: string, name: string, isCall: boolean, offset: number): string {
  if (isCall) return returnedLiteral(text, name);
  const definitions = [
    ...text.matchAll(
      new RegExp(String.raw`\b(?:const|let|var)\s+${escapeRe(name)}\b[^=;]{0,200}=\s*`, 'g')
    ),
  ];
  const definition = definitions.filter((d) => d.index! < offset).pop() ?? definitions[0];
  if (!definition) return '';
  const at = definition.index! + definition[0].length;
  const call = /^(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(at));
  return call ? returnedLiteral(text, call[1]) : objectAfter(text, at);
}

/**
 * Nested writes reached through a value built away from the call site: the relation value
 * names a variable defined in the same file as an object literal, or as a call to a
 * same-file function that returns one, or is such a call itself — and that literal holds a
 * nested-write key. The region is the object after that key, so the nested decisions
 * apply to it unchanged. One hop only; a definition in another file is not followed.
 */
function indirectNestedSites(file: string, text: string, kind: 'create' | 'update'): Site[] {
  const sites: Site[] = [];
  for (const m of text.matchAll(RELATION_VALUE)) {
    const offset = m.index ?? 0;
    const literal = relationLiteral(text, m[1] ?? m[3], m[2] === '(', offset);
    const key = NESTED_KEYS[kind].exec(literal);
    if (!key) continue;
    const fn = enclosingFunction(text, offset);
    sites.push({
      key: `${file}#${fn.name}`,
      region: objectAfter(literal, key.index + key[0].length),
      body: text.slice(fn.start, offset + 2000),
    });
  }
  return sites;
}

/**
 * The value of top-level property `name` in object literal `obj` (the name itself for a
 * shorthand), or null when `obj` has no such property.
 */
function propertyValue(obj: string, name: string): string | null {
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (
      depth === 1 &&
      obj.startsWith(name, i) &&
      !/[\w$.]/.test(obj[i - 1] ?? '') &&
      !/[\w$]/.test(obj[i + name.length] ?? '')
    ) {
      const rest = obj.slice(i + name.length);
      if (/^\s*[,}]/.test(rest)) return name;
      const colon = /^\s*:\s*/.exec(rest);
      if (!colon) continue;
      let inner = 0;
      const start = i + name.length + colon[0].length;
      for (let j = start; j < obj.length; j++) {
        const d = obj[j];
        if (d === '{' || d === '[' || d === '(') inner++;
        else if ((d === '}' || d === ']' || d === ')') && --inner < 0)
          return obj.slice(start, j).trim();
        else if (d === ',' && inner === 0) return obj.slice(start, j).trim();
      }
      return obj.slice(start).trim();
    }
  }
  return null;
}

/** Does object literal `obj` spread a value, or use a computed key, at its top level? */
function hasTopLevelSpreadOrComputedKey(obj: string): boolean {
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (depth === 1 && obj.startsWith('...', i)) return true;
    if (c === '[' && depth === 1 && /[{,]\s*$/.test(obj.slice(0, i))) return true;
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
  }
  return false;
}

/** A SET assignment to the `metadata` column, or a SET clause that opens with a fragment. */
const RAW_METADATA_SET = /(?:\bSET\b|,)\s*"?metadata"?\s*=(?!=)\s*/i;

/**
 * Does a SET clause open an assignment with an interpolated fragment (`SET ${clause}` or
 * `, ${clause}`) at paren depth 0? Such a fragment's columns are not readable here.
 */
function hasSetFragment(sql: string): boolean {
  const set = /\bSET\b/i.exec(sql);
  if (!set) return false;
  let depth = 0;
  let atAssignment = true;
  for (let i = set.index + 3; i < sql.length; ) {
    if (atAssignment) {
      const lead = /^(?:\s+|--[^\n]*)+/.exec(sql.slice(i));
      if (lead) i += lead[0].length;
      if (sql.startsWith('${', i)) return true;
      atAssignment = false;
    }
    if (sql.startsWith('${', i)) i = interpolationEnd(sql, i + 2);
    else if (sql[i] === '(') depth++, i++;
    else if (sql[i] === ')') depth--, i++;
    else if (depth === 0 && sql[i] === ',') (atAssignment = true), i++;
    else if (depth === 0 && /^\s(?:WHERE|RETURNING|FROM)\b/i.test(sql.slice(i, i + 12)))
      return false;
    else i++;
  }
  return false;
}

/**
 * Update population filter: a site is in the ledger when it can change `metadata` — it
 * names `metadata` in what it writes, or writes something this file cannot read (a
 * non-literal `data`, a top-level spread or computed key, an interpolated SET fragment).
 * A `where` that only READS `metadata` does not enter.
 */
function updateCanWriteMetadata(site: Site): boolean {
  const { region } = site;
  if (/^\s*(?:UPDATE)\b/i.test(region))
    return RAW_METADATA_SET.test(region) || hasSetFragment(region);
  // `.image.update(…)` regions hold the call's argument object; nested regions hold the
  // object after `update:` / `updateMany:`, whose own `data` (to-many) or body (to-one)
  // is the write.
  const data = /^\s*\{/.test(region) ? propertyValue(region, 'data') ?? region : null;
  if (data === null || !data.startsWith('{')) return true;
  return /\bmetadata\b/.test(data) || hasTopLevelSpreadOrComputedKey(data);
}

/** The expression assigned to `metadata` by a raw SET, up to the next top-level `,` or WHERE. */
function rawMetadataAssignment(sql: string): string | null {
  const m = RAW_METADATA_SET.exec(sql);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  for (let i = start; i < sql.length; ) {
    if (sql[i] === '$' && sql[i + 1] === '{') i = interpolationEnd(sql, i + 2);
    else if (sql[i] === '(') depth++, i++;
    else if (sql[i] === ')') depth--, i++;
    else if (depth === 0 && (sql[i] === ',' || /^\s+WHERE\b/i.test(sql.slice(i, i + 20))))
      return sql.slice(start, i).trim();
    else i++;
  }
  return sql.slice(start).trim();
}

/** An identifier's object-literal definition inside `body`, or the value itself. */
function resolveLiteral(value: string, body: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) return value;
  const def = new RegExp(String.raw`\bconst\s+${escapeRe(value)}\b[^=;]{0,200}=\s*`).exec(body);
  return def ? objectAfter(body, def.index + def[0].length) : value;
}

/** Spread sources accepted as an existing row's stored metadata. */
const STORED_METADATA_SOURCES = ['image.metadata', 'item.metadata'];

type UpdateDecision =
  /** `data` spreads caller input, then forces `metadata` from the row read before the write. */
  | 'stored-row-override'
  /** `metadata: { ...<stored row metadata>, <server keys> }`, directly or via a local const. */
  | 'stored-merge-server-keys'
  /** Raw SET building `metadata` from SQL literals, fixed keys and scalar-cast parameters. */
  | 'raw-server-keys'
  /** Raw SET from the moderation-rule result, which merges the stored row with rule keys. */
  | 'raw-mod-rule-metadata'
  /** `data` is `cond ? { … } : { … }`: two object literals, neither naming metadata. */
  | 'literal-branches'
  /** `data: { [flag]: <boolean> }`, `flag` being the schema's closed enum of boolean columns. */
  | 'boolean-flag-key';

/** Every update site that can write `metadata`, keyed by enclosing function. */
const UPDATE_SITE_LEDGER: Record<string, { decision: UpdateDecision; sites: number }> = {
  'src/server/services/post.service.ts#updatePostImage': {
    decision: 'stored-row-override',
    sites: 1,
  },
  'src/pages/api/webhooks/youtube-upload.ts#handler': {
    decision: 'stored-merge-server-keys',
    sites: 1,
  },
  // Module-level job body: the enclosing-function rule attributes it to `<module>`.
  'src/server/jobs/collection-contest-youtube-upload.ts#<module>': {
    decision: 'stored-merge-server-keys',
    sites: 2,
  },
  'src/server/services/image.service.ts#resolveIngestionError': {
    decision: 'stored-merge-server-keys',
    sites: 1,
  },
  'src/server/services/image-detail.service.ts#setVideoThumbnail': {
    decision: 'stored-merge-server-keys',
    sites: 1,
  },
  'src/server/services/image.service.ts#updateImageNsfwLevel': {
    decision: 'stored-merge-server-keys',
    sites: 1,
  },
  'src/server/jobs/remove-deleted-user-images.ts#blockUserImages': {
    decision: 'raw-server-keys',
    sites: 2,
  },
  'src/server/services/account-deletion-image-markers.ts#clearAccountDeletionImageMarkers': {
    decision: 'raw-server-keys',
    sites: 2,
  },
  'src/server/services/account-deletion-images.ts#unblockAccountDeletionImages': {
    decision: 'raw-server-keys',
    sites: 1,
  },
  'src/server/services/image.service.ts#fillVideoDimensions': {
    decision: 'raw-server-keys',
    sites: 1,
  },
  'src/server/services/image.service.ts#handleUnblockImages': {
    decision: 'raw-server-keys',
    sites: 1,
  },
  'src/server/services/image.service.ts#markRemixSourceReviewed': {
    decision: 'raw-server-keys',
    sites: 1,
  },
  'src/server/services/image-scan-pipeline.ts#resolveScanOutcome': {
    decision: 'raw-mod-rule-metadata',
    sites: 1,
  },
  // In the population only because their `data` is not a plain literal this file can read.
  'src/server/services/report.service.ts#resolveEntityAppeal': {
    decision: 'literal-branches',
    sites: 1,
  },
  'src/server/services/image.service.ts#toggleImageFlag': {
    decision: 'boolean-flag-key',
    sites: 1,
  },
  'src/server/services/image.service.ts#updateImagesFlag': {
    decision: 'boolean-flag-key',
    sites: 1,
  },
};

const IMAGE_SCHEMA = readFileSync(join(ROOT, 'src/server/schema/image.schema.ts'), 'utf8');

/** Does this update site's shape match its recorded decision? Returns a reason when not. */
function checkUpdateDecision(decision: UpdateDecision, site: Site): string | null {
  const { region, body } = site;
  switch (decision) {
    case 'stored-row-override': {
      if (!/\bconst currentImage = await dbWrite\.image\.findUniqueOrThrow\(/.test(body))
        return 'no longer reads the stored row before the write';
      // `metadata` must be the LAST property, so no spread or key after it can replace it.
      const data = propertyValue(region, 'data') ?? '';
      if (
        !/[{,]\s*metadata:\s*\{\s*\.\.\.\(\(currentImage\.metadata as MixedObject\) \?\? \{\}\),?\s*\} as Prisma\.JsonObject,?\s*\}$/.test(
          data
        )
      )
        return 'metadata after the input spread is no longer the stored row';
      return null;
    }
    case 'stored-merge-server-keys': {
      const value = propertyValue(propertyValue(region, 'data') ?? '', 'metadata');
      if (!value) return 'no longer writes metadata as a property';
      const literal = resolveLiteral(value, body);
      const spreads = [...literal.matchAll(/\.\.\./g)];
      const source = /^\{\s*\.\.\.([\w$]+(?:\.metadata)?)\s*,/.exec(literal)?.[1];
      if (!source || spreads.length !== 1)
        return 'metadata is not one spread of stored metadata plus literal keys';
      const isStored =
        STORED_METADATA_SOURCES.includes(source) ||
        new RegExp(String.raw`\bconst ${escapeRe(source)} = \(?image\.metadata\b`).test(body);
      if (!isStored) return `spreads ${source}, not an existing row's stored metadata`;
      if (PROVENANCE_TOKEN.test(literal)) return 'merged keys name a provenance key';
      return null;
    }
    case 'raw-server-keys': {
      const expr = rawMetadataAssignment(region);
      if (expr === null) return 'no longer assigns metadata';
      if (PROVENANCE_TOKEN.test(expr)) return 'names a provenance key';
      for (let i = expr.indexOf('${'); i !== -1; i = expr.indexOf('${', i + 2)) {
        const end = interpolationEnd(expr, i + 2);
        const param = expr.slice(i + 2, end - 1).trim();
        const cast = /^::(\w+)/.exec(expr.slice(end))?.[1];
        const fixedKey = /^[A-Z][A-Z0-9_]*$/.test(param) && cast === 'text';
        const scalar = cast !== undefined && ['int', 'integer', 'float8', 'numeric'].includes(cast);
        if (!fixedKey && !scalar) return `interpolates \${${param}} into metadata`;
      }
      return null;
    }
    case 'raw-mod-rule-metadata': {
      const expr = (rawMetadataAssignment(region) ?? '').replace(/\s+/g, ' ');
      if (
        expr !==
        'COALESCE(${ metadataUpdate ? JSON.stringify(metadataUpdate) : null }::jsonb, "metadata")'
      )
        return 'metadata is no longer the moderation-rule result or the stored value';
      if (
        !/let metadataUpdate[^;]*;\s*if \(modRule\) \{\s*metadataUpdate = modRule\.metadata;/.test(
          body
        )
      )
        return 'metadataUpdate is no longer taken from the moderation-rule result';
      return null;
    }
    case 'literal-branches': {
      const data = propertyValue(region, 'data') ?? '';
      if (!/^[\w.!]+\s*\?\s*\{[^{}]*\}\s*:\s*\{[^{}]*\}$/.test(data))
        return 'data is no longer a choice between two flat object literals';
      if (/\bmetadata\b|\.\.\.|\[/.test(data))
        return 'a branch writes metadata or an unreadable key';
      return null;
    }
    case 'boolean-flag-key': {
      const data = propertyValue(region, 'data') ?? '';
      if (!/^\{\s*\[flag\]:\s*(?:!image\[flag\]|value)\s*,?\s*\}$/.test(data))
        return 'data is no longer a single boolean flag column';
      if (!/\bToggleImageFlagInput\b/.test(body))
        return 'flag is no longer typed by the flag schema';
      if (
        !/toggleImageFlagSchema = z\.object\(\{\s*id: z\.number\(\),\s*flag: z\.enum\(\['minor', 'poi'\]\),\s*\}\)/.test(
          IMAGE_SCHEMA
        )
      )
        return 'the flag schema is no longer the closed enum of boolean columns';
      return null;
    }
  }
}

const scan = scanSource(ROOT);
const files = scan.files;
const commentless = new Map(
  files.map((f) => [f, stripComments(readFileSync(join(ROOT, f), 'utf8'))] as const)
);

function collect(re: RegExp): Site[] {
  return files.flatMap((f) => sitesIn(f, commentless.get(f)!, re));
}

function collectIndirect(kind: 'create' | 'update'): Site[] {
  return files.flatMap((f) => indirectNestedSites(f, commentless.get(f)!, kind));
}

const keysOf = (sites: Site[]) => [...new Set(sites.map((s) => s.key))].sort();
const countsOf = (sites: Site[]) =>
  Object.fromEntries(keysOf(sites).map((k) => [k, sites.filter((s) => s.key === k).length]));

describe('Image metadata provenance — write-site ledger', () => {
  const writeSites = [
    ...collect(WRITE_CALL),
    ...collect(RAW_INSERT),
    ...collect(NESTED_CREATE),
    ...collectIndirect('create'),
  ];

  it('scans a real population', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('src/server/services/image.service.ts');
    expect(IMAGE_RELATION_FIELDS).toEqual([
      'avatar',
      'cover',
      'coverImage',
      'headerImage',
      'heroImage',
      'icon',
      'image',
      'images',
      'pendingImage',
      'profilePicture',
      'sfwCoverImage',
      'sourceImage',
      'thumbnailImage',
    ]);
  });

  it('every Image insert site is classified, and no classified site has gone', () => {
    expect(countsOf(writeSites)).toEqual(
      Object.fromEntries(Object.entries(WRITE_SITE_LEDGER).map(([k, v]) => [k, v.sites]))
    );
  });

  it('no write call was matched inside a string literal', () => {
    const inCode = files.reduce(
      (n, f) => n + [...scan.code.get(f)!.matchAll(WRITE_CALL)].length,
      0
    );
    expect(collect(WRITE_CALL)).toHaveLength(inCode);
  });

  it('every site still has the shape its decision records', () => {
    const mismatches = writeSites
      .map((site) => {
        const entry = WRITE_SITE_LEDGER[site.key];
        const reason = entry ? checkDecision(entry.decision, site) : 'not in the ledger';
        return reason && `${site.key}: ${reason}`;
      })
      .filter(Boolean);
    expect(mismatches).toEqual([]);
  });
});

describe('Image metadata provenance — update-site ledger', () => {
  const updateSites = [
    ...collect(UPDATE_CALL),
    ...collect(RAW_UPDATE),
    ...collect(NESTED_UPDATE),
    ...collectIndirect('update'),
  ].filter((s) => updateCanWriteMetadata(s));

  it('scans a real update population', () => {
    // Positive control: the filter is applied to a population that is not empty.
    expect(collect(UPDATE_CALL).length).toBeGreaterThan(25);
    expect(collect(RAW_UPDATE).length).toBeGreaterThan(25);
  });

  it('every Image update that can write metadata is classified, and none has gone', () => {
    expect(countsOf(updateSites)).toEqual(
      Object.fromEntries(Object.entries(UPDATE_SITE_LEDGER).map(([k, v]) => [k, v.sites]))
    );
  });

  it('every update site still has the shape its decision records', () => {
    const mismatches = updateSites
      .map((site) => {
        const entry = UPDATE_SITE_LEDGER[site.key];
        const reason = entry ? checkUpdateDecision(entry.decision, site) : 'not in the ledger';
        return reason && `${site.key}: ${reason}`;
      })
      .filter(Boolean);
    expect(mismatches).toEqual([]);
  });
});

describe('Image metadata provenance — stamper ledger', () => {
  it('only the recorded functions name blockProvenance, and each still does', () => {
    expect(keysOf(collect(STAMPER))).toEqual([...STAMPER_FUNCTIONS].sort());
  });

  it('only the recorded sites write a provenance key as an object key', () => {
    expect(countsOf(collect(PROVENANCE_KEY_WRITE))).toEqual(PROVENANCE_KEY_WRITE_LEDGER);
  });
});

describe('detector controls', () => {
  const fixture = (src: string) => stripComments(src);

  it('finds a write call and names its function', () => {
    const text = fixture(
      'async function addThing(input) {\n  await dbWrite.image.create({ data: { ...input } });\n}'
    );
    const [site] = sitesIn('x.ts', text, WRITE_CALL);
    expect(site.key).toBe('x.ts#addThing');
    expect(site.region).toBe('{ data: { ...input } }');
  });

  it('ignores a write call that only appears in a comment', () => {
    const text = fixture('// dbWrite.image.create(x)\nconst a = 1;');
    expect(sitesIn('x.ts', text, WRITE_CALL)).toEqual([]);
  });

  it('finds a raw insert', () => {
    const text = fixture('async function dup() { await q(`INSERT INTO "Image" (url) SELECT 1`); }');
    expect(sitesIn('x.ts', text, RAW_INSERT).map((s) => s.key)).toEqual(['x.ts#dup']);
  });

  it.each([
    [
      'const persist = async (appId) => ({ metadata: { [BLOCK_UPLOADED_APP_ID_META_KEY]: appId } })',
    ],
    ['const persist = async (appId) => ({ metadata: { blockForkedAppId: appId } })'],
    ["const persist = async (appId) => ({ metadata: { 'blockPublishedAppId': appId } })"],
    ['const persist = async (m, appId) => { m.blockPublishedAppId = appId; }'],
    ['const persist = async (m, blockPublishedAppId) => ({ ...m, blockPublishedAppId })'],
    ["const persist = async (appId) => ({ ['blockPublishedAppId']: appId })"],
    ["const persist = async (m, appId) => { m['blockPublishedAppId'] = appId; }"],
    [
      "const persist = async (id) => q(`SET metadata = jsonb_set(metadata, '{blockPublishedAppId}', ${id})`)",
    ],
    [
      "const persist = async (id) => q(`jsonb_build_object('a', lower('x'), 'blockPublishedAppId', ${id})`)",
    ],
    ['const persist = async (m, appId) => { m[BLOCK_PUBLISHED_APP_ID_META_KEY] = appId; }'],
    [
      "const persist = async (id) => q(`SET metadata = jsonb_build_object('blockPublishedAppId', ${id})`)",
    ],
  ])('flags a provenance key write: %s', (src) => {
    expect(sitesIn('x.ts', fixture(src), PROVENANCE_KEY_WRITE).map((s) => s.key)).toEqual([
      'x.ts#persist',
    ]);
  });

  it('finds a nested Image relation create behind a conditional', () => {
    const text = fixture(
      'async function save(p) {\n  await db.user.update({ data: { avatar: p\n ? { create: { ...p } } : undefined } });\n}'
    );
    const [site] = sitesIn('x.ts', text, NESTED_CREATE);
    expect(site.key).toBe('x.ts#save');
    expect(checkDecision('nested-strip', site)).toBe(
      'nested create no longer strips the input metadata'
    );
  });

  it('does not flag a provenance key read or comparison', () => {
    const text = fixture(
      'function read(m) { const { blockPublishedAppId } = m; return m[BLOCK_PUBLISHED_APP_ID_META_KEY] === m.blockPublishedAppId; }'
    );
    expect(sitesIn('x.ts', text, PROVENANCE_KEY_WRITE)).toEqual([]);
  });

  it('finds a blockProvenance passed as shorthand', () => {
    const text = fixture(
      'async function stamp(blockProvenance) { await createImage({ url, blockProvenance }); }'
    );
    expect(keysOf(sitesIn('x.ts', text, STAMPER))).toEqual(['x.ts#stamp']);
  });

  it('counts a second write site in an already-listed function', () => {
    const text = fixture(
      'async function f(a, b) { await db.image.create({ data: a }); await db.image.create({ data: b }); }'
    );
    expect(countsOf(sitesIn('x.ts', text, WRITE_CALL))).toEqual({ 'x.ts#f': 2 });
  });

  it('ends a raw insert at its own template, not at a later statement', () => {
    const text = fixture(
      'async function add(u) { await db.$queryRaw`INSERT INTO "Image" (url) VALUES (${u})`; }\n' +
        'async function dup(id) { await db.$queryRawUnsafe(`SELECT 1 FROM "Image" i WHERE i.id = ${id}`); }'
    );
    const [site] = sitesIn('x.ts', text, RAW_INSERT);
    expect(site.region).toBe('INSERT INTO "Image" (url) VALUES (${u})');
    expect(checkDecision('copied-from-stored-row', site)).toContain('no longer an INSERT … SELECT');
  });

  it('accepts the stripped and server-literal nested shapes', () => {
    expect(
      checkDecision('nested-strip', {
        key: 'x',
        region: '{ ...p, metadata: { ...stripBlockProvenanceMetadata(p.metadata), a: 1 }, userId }',
        body: '',
      })
    ).toBeNull();
    expect(
      checkDecision('nested-server-literal', {
        key: 'x',
        region: '{ where: { id }, create: { ...image, metadata: { coverImage: true, userId } } }',
        body: '',
      })
    ).toBeNull();
  });

  it('reads no region from a nested create whose value is not a literal', () => {
    const text = fixture(
      'async function save(a) {\n  await db.user.update({ data: { avatar: { create: a } } });\n  const other = { metadata: { x: 1 } };\n}'
    );
    const [site] = sitesIn('x.ts', text, NESTED_CREATE);
    expect(site.region).toBe('');
    expect(checkDecision('nested-server-literal', site)).not.toBeNull();
  });

  it('counts a provenance key write added under an already-listed function', () => {
    const text = fixture(
      'async function createImage(m, blockProvenance) { return { ...m, [blockProvenance.key]: 1 }; }\n' +
        'export const tagAppImage = (m, id) => ({ ...m, [BLOCK_PUBLISHED_APP_ID_META_KEY]: id });\n' +
        'export const stampIt = (blockProvenance) => doThing({ blockProvenance });'
    );
    expect(countsOf(sitesIn('x.ts', text, PROVENANCE_KEY_WRITE))).toEqual({
      'x.ts#createImage': 2,
    });
    expect(keysOf(sitesIn('x.ts', text, STAMPER))).toEqual(['x.ts#createImage']);
  });

  it('accepts a conditional spread of object literals in a server-literal site', () => {
    const region = '{ data: { metadata: { size: 1, ...(auto ? { autogenerated: true } : {}) } } }';
    expect(checkDecision('server-literal', { key: 'x', region, body: '' })).toBeNull();
  });

  it.each<[Decision, string, string]>([
    ['no-metadata', '{ data: { url, metadata: input.metadata } }', 'now writes metadata'],
    ['no-metadata', '{ data: { ...input } }', 'now spreads a value into the row'],
    ['no-metadata', '{ data: { ...(input) } }', 'now spreads a value into the row'],
    ['server-literal', '{ data: { metadata: args.metadata } }', 'not an object literal'],
    ['server-literal', '{ data: { metadata: { ...(args.metadata) } } }', 'spreads a value'],
    [
      'copied-from-stored-row',
      'INSERT INTO "Image" (url) VALUES (${url})',
      'no longer an INSERT … SELECT',
    ],
    [
      'createImage-strip',
      'const metadata = stripBlockProvenanceMetadata(image.metadata); { data: { ...pickClientImageColumns(image), metadata: blockProvenance ? { ...image.metadata } : metadata, meta } }',
      'createImage no longer writes',
    ],
    [
      'createImage-strip',
      'const metadata = stripBlockProvenanceMetadata(image.metadata); { data: { metadata: blockProvenance ? { ...metadata, [blockProvenance.key]: blockProvenance.appId } : metadata, ...pickClientImageColumns(image), meta } }',
      'createImage no longer writes',
    ],
    [
      'createImage-strip',
      'const metadata = stripBlockProvenanceMetadata(image.metadata); { data: { ...image, metadata: blockProvenance ? { ...metadata, [blockProvenance.key]: blockProvenance.appId } : metadata, meta } }',
      'createImage no longer writes',
    ],
    ['in-function-strip', '{ data: { ...image, meta } }', 'spreads input without overriding'],
    [
      'nested-strip',
      '{ ...p, metadata: { ...stripBlockProvenanceMetadata(p.metadata), ...p.metadata } }',
      'nested create no longer strips',
    ],
    [
      'nested-strip',
      '{ metadata: { ...stripBlockProvenanceMetadata(p.metadata) }, ...p }',
      'nested create no longer strips',
    ],
    [
      'in-function-strip',
      '{ data: { metadata: stripBlockProvenanceMetadata(image.metadata), ...image } }',
      'spreads input without overriding',
    ],
    [
      'nested-server-literal',
      '{ create: { ...image, metadata: { coverImage: true, ...image.metadata } } }',
      'not a literal after the spreads',
    ],
    [
      'nested-server-literal',
      '{ create: { ...image, metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: id } } }',
      'names a provenance key',
    ],
    [
      'nested-server-literal',
      '{ create: { ...image, metadata: image.metadata } }',
      'not a literal',
    ],
    [
      'server-literal',
      '{ data: { metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: id } } }',
      'provenance',
    ],
  ])('rejects a %s site that drifted: %s', (decision, region, reason) => {
    expect(checkDecision(decision, { key: 'x', region, body: region })).toContain(reason);
  });

  it('follows a nested create built in a helper into the use site', () => {
    const text = fixture(
      'function buildPic(input) {\n  const pic = { create: { ...input } };\n  return pic;\n}\n' +
        'async function save(input) {\n  const pic = { create: { ...input } };\n' +
        '  await db.user.update({ data: { profilePicture: pic } });\n}'
    );
    const sites = indirectNestedSites('x.ts', text, 'create');
    expect(sites.map((s) => s.key)).toEqual(['x.ts#save']);
    expect(sites[0].region).toBe('{ ...input }');
    expect(checkDecision('nested-strip', sites[0])).toBe(
      'nested create no longer strips the input metadata'
    );
  });

  it('follows a shorthand relation value and a conditional one', () => {
    const text = fixture(
      'async function save(input) {\n  const avatar = { connectOrCreate: { where: { id: 1 }, create: { ...input } } };\n' +
        '  await db.user.update({ data: { avatar } });\n' +
        '  await db.user.update({ data: { cover: input.x ? avatar : undefined } });\n}'
    );
    expect(indirectNestedSites('x.ts', text, 'create').map((s) => s.key)).toEqual([
      'x.ts#save',
      'x.ts#save',
    ]);
  });

  it('follows a nested create returned by a same-file helper, called directly or via a variable', () => {
    const text = fixture(
      'function buildPic({ input }) {\n  return { create: { ...input } };\n}\n' +
        'const buildCover = (input) => ({ connectOrCreate: { create: { ...input } } });\n' +
        'async function save(input) {\n  const pic = buildPic(input);\n' +
        '  await db.user.update({ data: { profilePicture: pic } });\n' +
        '  await db.user.update({ data: { profilePicture: buildPic(input), cover: buildCover(input) } });\n}'
    );
    const sites = indirectNestedSites('x.ts', text, 'create');
    expect(sites.map((s) => [s.key, s.region])).toEqual([
      ['x.ts#save', '{ ...input }'],
      ['x.ts#save', '{ ...input }'],
      ['x.ts#save', '{ create: { ...input } }'],
    ]);
  });

  it('does not take a return from outside the helper it follows', () => {
    const text = fixture(
      'function helper(input) {\n  const pic = { id: input };\n  return pic;\n}\n' +
        'function other() {\n  return { create: { a: 1 } };\n}\n' +
        'async function save(input) {\n  await db.user.update({ data: { profilePicture: helper(input) } });\n}'
    );
    expect(indirectNestedSites('x.ts', text, 'create')).toEqual([]);
  });

  it('does not follow an identifier whose definition has no nested write', () => {
    const text = fixture(
      'async function save(id) {\n  const image = { id };\n  return db.post.findMany({ select: { image: true }, where: { image } });\n}'
    );
    expect(indirectNestedSites('x.ts', text, 'create')).toEqual([]);
  });

  it.each([
    ['{ where: { id }, data: { metadata: input.metadata } }', true],
    ['{ where: { id }, data: input }', true],
    ['{ where: { id }, data }', true],
    ['{ where: { id }, data: { ...input, url } }', true],
    ['{ where: { id }, data: { [key]: value } }', true],
    ['{ where: { id, metadata: { path: ["x"], equals: 1 } }, data: { postId } }', false],
    ['{ where: { id }, data: { meta: { ...meta, hashes } } }', false],
    ['{ where: { id }, data: { nsfwLevel: 1 } }', false],
    [
      'UPDATE "Image" SET metadata = metadata || ${JSON.stringify(m)}::jsonb WHERE id = ${id}',
      true,
    ],
    ['UPDATE "Image" SET "nsfwLevel" = 1, ${clause} WHERE id = ${id}', true],
    ['UPDATE "Image" SET ${clause} WHERE id = ${id}', true],
    [
      'UPDATE "Image" SET "scanJobs" = jsonb_set(x, \'{a}\', ${JSON.stringify(a)}::jsonb) WHERE id = ${id}',
      false,
    ],
    ['', true],
    ['{ data: { metadata: x } }', true],
    ['{ where: { id }, data: { index: 1 } }', false],
  ])('update population membership: %s → %s', (region, member) => {
    expect(updateCanWriteMetadata({ key: 'x', region, body: '' })).toBe(member);
  });

  it('finds a nested Image relation update', () => {
    const text = fixture(
      'async function save(p) {\n  await db.post.update({ data: { images: { update: { where: { id }, data: { metadata: p.metadata } } } } });\n}'
    );
    const sites = sitesIn('x.ts', text, NESTED_UPDATE);
    expect(sites.map((s) => s.key)).toEqual(['x.ts#save']);
    expect(updateCanWriteMetadata(sites[0])).toBe(true);
  });

  it('finds a raw metadata update and names its function', () => {
    const text = fixture(
      'async function tag(id, m) {\n  await db.$executeRaw`UPDATE "Image" SET metadata = metadata || ${JSON.stringify(m)}::jsonb WHERE id = ${id}`;\n}'
    );
    const [site] = sitesIn('x.ts', text, RAW_UPDATE);
    expect(site.key).toBe('x.ts#tag');
    expect(checkUpdateDecision('raw-server-keys', site)).toBe(
      'interpolates ${JSON.stringify(m)} into metadata'
    );
  });

  it('accepts the server-built update shapes', () => {
    const raw = (sql: string) => ({ key: 'x', region: sql, body: '' });
    expect(
      checkUpdateDecision(
        'raw-server-keys',
        raw(
          'UPDATE "Image" SET "metadata" = "metadata" || jsonb_build_object(${PRIOR_KEY}::text, ingestion::text, \'w\', ${w}::int), x = 1 WHERE id = ${id}'
        )
      )
    ).toBeNull();
    expect(
      checkUpdateDecision('stored-merge-server-keys', {
        key: 'x',
        region: '{ where: { id }, data: { metadata: next } }',
        body: 'const metadata = (image.metadata as M) ?? {}; const next = { ...metadata, reason: r };',
      })
    ).toBeNull();
  });

  it.each<[UpdateDecision, string, string, string]>([
    [
      'raw-server-keys',
      'UPDATE "Image" SET metadata = jsonb_build_object(${key}::text, 1) WHERE id = 1',
      '',
      'interpolates ${key}',
    ],
    [
      'raw-server-keys',
      'UPDATE "Image" SET metadata = metadata || ${Prisma.raw(x)} WHERE id = 1',
      '',
      'interpolates',
    ],
    [
      'raw-server-keys',
      'UPDATE "Image" SET metadata = metadata || \'{"blockPublishedAppId": 1}\'::jsonb WHERE id = 1',
      '',
      'provenance',
    ],
    ['raw-server-keys', 'UPDATE "Image" SET "nsfwLevel" = 1 WHERE id = 1', '', 'no longer assigns'],
    [
      'stored-merge-server-keys',
      '{ where: { id }, data: { metadata: { ...input.metadata, a: 1 } } }',
      '',
      'not an existing row',
    ],
    [
      'stored-merge-server-keys',
      '{ where: { id }, data: { metadata: { ...image.metadata, ...extra } } }',
      '',
      'one spread',
    ],
    [
      'stored-merge-server-keys',
      '{ where: { id }, data: { metadata: { ...image.metadata, blockForkedAppId: 1 } } }',
      '',
      'provenance',
    ],
    [
      'stored-merge-server-keys',
      '{ where: { id }, data: { metadata: { ...metadata, a: 1 } } }',
      'const metadata = input.metadata;',
      'not an existing row',
    ],
    [
      'stored-row-override',
      '{ where: { id }, data: { ...image, metadata: { ...((currentImage.metadata as MixedObject) ?? {}) } as Prisma.JsonObject, ...extra } }',
      'const currentImage = await dbWrite.image.findUniqueOrThrow(',
      'no longer the stored row',
    ],
    [
      'stored-row-override',
      '{ where: { id }, data: { ...image } }',
      'const currentImage = await dbWrite.image.findUniqueOrThrow(',
      'no longer the stored row',
    ],
    [
      'raw-mod-rule-metadata',
      'UPDATE "Image" SET "metadata" = COALESCE(${JSON.stringify(input)}::jsonb, "metadata") WHERE id = 1',
      '',
      'no longer the moderation-rule result',
    ],
    [
      'literal-branches',
      '{ where: { id }, data: ok ? { a: 1 } : input }',
      '',
      'two flat object literals',
    ],
    [
      'literal-branches',
      '{ where: { id }, data: ok ? { metadata: m } : { a: 1 } }',
      '',
      'writes metadata',
    ],
    [
      'boolean-flag-key',
      '{ where: { id }, data: { [flag]: input.value } }',
      'ToggleImageFlagInput',
      'single boolean flag column',
    ],
  ])('rejects a %s update site that drifted: %s', (decision, region, body, reason) => {
    expect(checkUpdateDecision(decision, { key: 'x', region, body })).toContain(reason);
  });
});
