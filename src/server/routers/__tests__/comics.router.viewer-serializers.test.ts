import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every comics procedure that reads or writes panels or references returns their media through
 * `panelsForViewer` / `panelForViewer` / `polledMediaForViewer` / `referenceForViewer`, which hold
 * it to the block rule, or is listed here with why it returns none of that media. No row may be a
 * hazard: a procedure that returns media goes through a serializer.
 */
const LEDGER: Record<string, string> = {
  getMyProjects:
    "one thumbnail URL per project, from a panel the query's where already holds to the block; no metadata",
  getProjectForReader:
    'no panel metadata; withholdRestrictedPanelImages decides each imageUrl by the block rule',
  getGenerationCostEstimate: 'a Buzz estimate',
  enhancePromptText: 'the enhanced prompt text',
  duplicateChapter: 'the new chapter row, without its panels',
  createReference: 'the new reference row, without images',
  deletePanel: '{ success }',
  reorderPanels: '{ success }',
  iterateGenerate: 'the workflow id, size and cost; no panel',
  planChapterPanels: 'planned panel prompts',
  publishChapter: 'the chapter row, without its panels',
  deleteReference: '{ success }',
  updateReference: 'the reference row, without images',
  deleteReferenceImage: '{ success }',
  reorderReferenceImages: '{ success }',
  addReferenceToProject: '{ success }',
};

const SERIALIZER = /\b(panelsForViewer|panelForViewer|polledMediaForViewer|referenceForViewer)\(/;
const TOUCHES = /\.comic(Panel|Reference|ReferenceImage)\b|\b(panels|references|images): \{/;

function procedures(source: string) {
  const heads = [...source.matchAll(/^ {2}(\w+): comic\w*Procedure\b/gm)];
  return heads.map((head, i) => ({
    name: head[1],
    body: source.slice(head.index, heads[i + 1]?.index ?? source.length),
  }));
}

function audit(source: string, ledger: Record<string, string>) {
  const all = procedures(source);
  const touching = all.filter((p) => TOUCHES.test(p.body));
  return {
    unserialized: touching
      .filter((p) => !SERIALIZER.test(p.body) && !(p.name in ledger))
      .map((p) => p.name),
    // A listed procedure that now serializes, or is gone, or touches neither table.
    stale: Object.keys(ledger).filter((name) => {
      const p = touching.find((t) => t.name === name);
      return !p || SERIALIZER.test(p.body);
    }),
    touching: touching.length,
  };
}

const source = readFileSync(join(__dirname, '..', 'comics.router.ts'), 'utf8');

describe('comics procedures and the viewer serializers', () => {
  it('route panel and reference media through a serializer, or are listed with a reason', () => {
    const result = audit(source, LEDGER);
    expect(result.touching).toBeGreaterThan(20);
    expect({ unserialized: result.unserialized, stale: result.stale }).toEqual({
      unserialized: [],
      stale: [],
    });
  });

  it('reports a procedure whose serializer call is removed, and a ledger entry that serializes', () => {
    const anchor = 'return panelForViewer(updated, image, ctx);';
    expect(source.split(anchor)).toHaveLength(2);
    const mutated = source.replace(anchor, () => 'return { ...updated, image };');
    expect(audit(mutated, LEDGER).unserialized).toEqual(['updatePanel']);
    expect(audit(source, { ...LEDGER, getChapter: 'listed' }).stale).toEqual(['getChapter']);
  });
});
