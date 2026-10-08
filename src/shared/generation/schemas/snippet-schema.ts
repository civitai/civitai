/**
 * Snippet Value Schemas
 *
 * Zod schemas + TS types for the `SnippetsNode`'s per-reference value shape.
 * Lives outside `generation/` so both the graph-side factories and any
 * non-graph consumers (e.g. `promptEnhancement.schema.ts`) can import the
 * same canonical definitions instead of redeclaring them.
 *
 * Mirrors the §"Snippets / Wildcard Sets" doc: each `SnippetReferenceValue`
 * is one `#category` reference inside an editor's prompt; each
 * `SnippetReferenceSelectionValue` is a per-source narrowing of that
 * reference (`in`/`ex` are explicit include/exclude lists scoped to one
 * `categoryId` from a loaded wildcard set). v1 always submits with empty
 * selections — the per-value picker is post-v1.
 */

import z from 'zod';

export const snippetReferenceSelectionSchema = z.object({
  categoryId: z.number().int().positive(),
  in: z.array(z.string()).default([]),
  ex: z.array(z.string()).default([]),
});

export const snippetReferenceSchema = z.object({
  category: z.string(),
  selections: z.array(snippetReferenceSelectionSchema).default([]),
});

export type SnippetReferenceSelectionValue = {
  categoryId: number;
  in: string[];
  ex: string[];
};

export type SnippetReferenceValue = {
  category: string;
  selections: SnippetReferenceSelectionValue[];
};
