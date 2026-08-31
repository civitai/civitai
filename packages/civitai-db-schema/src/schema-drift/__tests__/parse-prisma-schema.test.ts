import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countOwningRelationLines,
  defaultOnDelete,
  defaultOnUpdate,
  parsePrismaSchema,
} from '../parse-prisma-schema';
import type { ParsedModel } from '../types';

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures/fixture.prisma'), 'utf8');
const REAL_SCHEMA = join(here, '../../../prisma/schema.full.prisma');

function model(models: ParsedModel[], name: string): ParsedModel {
  const found = models.find((m) => m.name === name);
  if (!found) throw new Error(`fixture is missing model ${name}`);
  return found;
}

describe('parsePrismaSchema', () => {
  const { models } = parsePrismaSchema(FIXTURE);

  it('finds every model block', () => {
    expect(models.map((m) => m.name).sort()).toEqual([
      'Author',
      'Comment',
      'LegacyThing',
      'Post',
      'Project',
      'ProjectSlot',
      'ReportView',
    ]);
  });

  it('maps @@map to the table name and defaults to the model name', () => {
    expect(model(models, 'Post').table).toBe('posts');
    expect(model(models, 'ReportView').table).toBe('report_view');
    expect(model(models, 'Author').table).toBe('Author');
  });

  it('maps @map to the column name and defaults to the field name', () => {
    const post = model(models, 'Post');
    expect(post.fields.find((f) => f.name === 'body')?.column).toBe('body_text');
    expect(post.fields.find((f) => f.name === 'title')?.column).toBe('title');
  });

  it('marks @@ignore models', () => {
    expect(model(models, 'LegacyThing').ignored).toBe(true);
    expect(model(models, 'Post').ignored).toBe(false);
  });

  it('records optionality, lists and scalar-ness', () => {
    const post = model(models, 'Post');
    const byName = new Map(post.fields.map((f) => [f.name, f]));
    expect(byName.get('title')).toMatchObject({ optional: false, list: false, scalar: true });
    expect(byName.get('archived')).toMatchObject({ optional: true, list: false, scalar: true });
    expect(byName.get('comments')).toMatchObject({ list: true, scalar: false });
    expect(byName.get('author')).toMatchObject({ scalar: false, type: 'Author' });
  });

  it('collects @unique and @@unique declarations', () => {
    expect(model(models, 'Author').uniques).toEqual([{ fields: ['email'], source: '@unique' }]);
    expect(model(models, 'Project').uniques).toEqual([
      { fields: ['projectId', 'position'], source: '@@unique' },
    ]);
  });

  it('collects only owning-side relations (the side carrying fields/references)', () => {
    // Author declares `posts Post[]` and `comments Comment[]` — back-references, no
    // `fields:`/`references:`, no foreign key. They must not be counted as relations.
    expect(model(models, 'Author').relations).toEqual([]);
    expect(model(models, 'Post').relations).toHaveLength(1);
  });

  it('keeps the declared order of composite relation columns', () => {
    const relation = model(models, 'ProjectSlot').relations[0];
    expect(relation.fields).toEqual(['projectId', 'position']);
    expect(relation.references).toEqual(['projectId', 'position']);
  });

  it('does not assume the referenced column is `id`', () => {
    expect(model(models, 'ProjectSlot').relations[0].references).not.toContain('id');
  });

  it('parses the positional @relation("Name", fields: ...) form', () => {
    const relation = model(models, 'ReportView').relations[0];
    expect(relation.field).toBe('author');
    expect(relation.targetModel).toBe('Author');
    expect(relation.fields).toEqual(['authorId']);
  });

  // Prisma accepts both spellings of the relation name. Rejecting this one did not error
  // and did not skip: the relation ceased to exist as far as the tool was concerned, so it
  // appeared in no counter and produced no finding. Six real relations were invisible.
  it('parses the named-argument @relation(name: "Name", fields: ...) form', () => {
    const relation = model(models, 'ProjectSlot').relations[0];
    expect(relation.field).toBe('project');
    expect(relation.targetModel).toBe('Project');
    expect(relation.fields).toEqual(['projectId', 'position']);
    expect(relation.onDelete).toBe('Cascade');
  });

  it('ignores a commented-out block attribute', () => {
    // `Comment` carries a `// @@ignore` line. Matching block attributes against the raw
    // body would skip the model and every constraint on it.
    expect(model(models, 'Comment').ignored).toBe(false);
  });

  it('ignores a commented-out @@map', () => {
    const parsed = parsePrismaSchema(`model A {
  id Int @id
  // @@map("wrong_table")
}`);
    expect(parsed.models[0].table).toBe('A');
  });

  it('reads an explicit onDelete', () => {
    const relation = model(models, 'Comment').relations.find((r) => r.field === 'post');
    expect(relation).toMatchObject({ onDelete: 'Cascade', onDeleteExplicit: true });
  });

  describe('implicit referential actions', () => {
    // Prisma's default onDelete is NOT Cascade. Getting this wrong turns a Restrict that
    // would reject every parent delete into an apparent cascade-delete risk, and vice versa.
    it('defaults a REQUIRED relation to Restrict', () => {
      expect(defaultOnDelete(false)).toBe('Restrict');
      const relation = model(models, 'Post').relations[0];
      expect(relation).toMatchObject({
        optional: false,
        onDelete: 'Restrict',
        onDeleteExplicit: false,
      });
    });

    it('defaults an OPTIONAL relation to SetNull', () => {
      expect(defaultOnDelete(true)).toBe('SetNull');
      const relation = model(models, 'Comment').relations.find((r) => r.field === 'author');
      expect(relation).toMatchObject({
        optional: true,
        onDelete: 'SetNull',
        onDeleteExplicit: false,
      });
    });

    it('defaults onUpdate to Cascade for both', () => {
      expect(defaultOnUpdate()).toBe('Cascade');
      expect(model(models, 'Post').relations[0]).toMatchObject({
        onUpdate: 'Cascade',
        onUpdateExplicit: false,
      });
    });
  });

  it('rejects an unrecognised referential action rather than silently defaulting', () => {
    const bad = `model A {
  id  Int @id
  bId Int
  b   B   @relation(fields: [bId], references: [id], onDelete: Explode)
}`;
    expect(() => parsePrismaSchema(bad)).toThrow(/Explode/);
  });

  describe('against the real schema', () => {
    const parsed = parsePrismaSchema(readFileSync(REAL_SCHEMA, 'utf8'));

    const source = readFileSync(REAL_SCHEMA, 'utf8');

    // The guard this test used to be was `relations.length > 400`, and a floor cannot see
    // an undercount: the parser was missing six owning-side relations and the assertion
    // passed. Checking against an INDEPENDENTLY derived count can see it, and keeps
    // working as the schema grows — no number to update by hand.
    it('finds every owning-side relation in the schema', () => {
      const relations = parsed.models.flatMap((m) => m.relations);
      expect(relations.length).toBe(countOwningRelationLines(source));
    });

    it('the independent count is itself non-trivial (control on the assertion above)', () => {
      // Two equal zeros would satisfy the equality above without either side working.
      expect(countOwningRelationLines(source)).toBeGreaterThan(400);
      expect(parsed.models.length).toBeGreaterThan(200);
    });

    it('parses both relation-name spellings out of the real schema', () => {
      const named = parsed.models.flatMap((m) =>
        m.relations.filter((r) => /Club|ChatMessage/.test(r.model))
      );
      expect(named.length).toBeGreaterThan(0);
      // The three Club image relations are the ones with no foreign key in production.
      const club = parsed.models.find((m) => m.name === 'Club');
      expect(club?.relations.map((r) => r.field)).toEqual(
        expect.arrayContaining(['coverImage', 'headerImage', 'avatar'])
      );
    });

    it('defaults every UNWRITTEN onDelete the way Prisma does — never to Cascade', () => {
      // The regression this pins: `image Image @relation(fields: [imageId], references: [id])`
      // with no onDelete. Reading that as a cascade mis-describes what the database would do
      // to a parent delete — on a required relation the truth is the opposite of a cascade,
      // the delete is REJECTED.
      //
      // Asserted over the whole POPULATION of bare relations rather than at one named model.
      // This test used to pin `TagsOnImageNew.image`, and #3589 gave that relation an
      // explicit `onDelete: Cascade` — which made the assertion fail while saying nothing
      // about the parser. A single named site decays every time someone annotates it; the
      // population cannot be retired by an ordinary schema edit.
      const bare = parsed.models.flatMap((m) => m.relations).filter((r) => !r.onDeleteExplicit);
      const bareRequired = bare.filter((r) => !r.optional);
      const bareOptional = bare.filter((r) => r.optional);

      // Positive control: an empty population would satisfy every `every()` below.
      expect(bareRequired.length).toBeGreaterThan(0);
      expect(bareOptional.length).toBeGreaterThan(0);

      expect(bareRequired.every((r) => r.onDelete === 'Restrict')).toBe(true);
      expect(bareOptional.every((r) => r.onDelete === 'SetNull')).toBe(true);
      expect(bare.some((r) => r.onDelete === 'Cascade')).toBe(false);
      // onUpdate's default IS Cascade, for both — the asymmetry is the whole point.
      expect(bare.every((r) => r.onUpdate === 'Cascade')).toBe(true);
    });

    it('finds relations that reference a column other than id', () => {
      const nonId = parsed.models
        .flatMap((m) => m.relations)
        .filter((r) => r.references.some((ref) => ref !== 'id'));
      expect(nonId.length).toBeGreaterThan(0);
    });
  });
});
