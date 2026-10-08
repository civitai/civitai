import { globSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { CORRECTION_MESSAGE_KINDS, correctionMessage } from '../FieldCorrectionNote';

/**
 * The note rendering is a string lookup on `note.kind`, which is the def's `reason`. Nothing
 * type-checks that join: rename a reason and the control silently goes back to correcting in
 * silence — the exact state this was built to end, failing in the direction nobody notices.
 *
 * So each surfaced kind is pinned to a def that really emits it, driven through the store the
 * way ingestion does (`set()` skips `input`, so the hook is what produces the note).
 */

const repoRoot = path.resolve(__dirname, '../../../../..');
// The whole form-graph tree, not just `generation/`: `enumDef`/`selectDef` live one level up
// in `src/shared/form-graph/defs.ts` and emit surfaced reasons too, so a narrower glob would
// report a live kind as orphaned.
const GRAPHS = 'src/shared/form-graph';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

type Store = ReturnType<typeof generationHub.createStore>;
const noteFor = (store: Store, key: string) => store.getField(key)?.note;

describe('a corrected field produces a note the UI can render', () => {
  it('resolution: an option from another family', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img', ecosystem: 'Flux3', prompt: 'a cat' });
    store.set({ resolution: '8k' });

    const note = noteFor(store, 'resolution');
    expect(note?.kind).toBe('option_unavailable');
    expect(correctionMessage(note)).toContain('1k');
  });

  it('seed: a value past what the generator can reproduce', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' });
    store.set({ seed: 9_999_999_999_999 });

    const note = noteFor(store, 'seed');
    expect(note?.kind).toBe('seed_unreproducible');
    expect(correctionMessage(note)).toMatch(/seed/i);
  });

  it('duration: a length from another video family', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2vid', ecosystem: 'Grok', prompt: 'a cat' });
    const meta = store.getField('duration')?.meta as { max: number };
    store.set({ duration: meta.max + 1 });

    const note = noteFor(store, 'duration');
    expect(note?.kind).toBeDefined();
    expect(
      correctionMessage(note),
      `duration corrects with reason "${note?.kind}", which FieldCorrectionNote does not ` +
        'surface — the clamp would be silent'
    ).toBeTruthy();
  });

  // Guard the guard. Without this the three cases above would also pass if the message map
  // were emptied, and a kind kept in the map after its reason was renamed would never be
  // noticed — the map would quietly stop matching anything.
  it('every surfaced kind is still emitted by some def', () => {
    // Every graph file, globbed — a hand-listed file set is how this kind of scan goes
    // stale, and it did: the first version named three files, missed `duration_range` in
    // `video/wan.graph.ts`, and reported a live reason as orphaned.
    const emitted = new Set<string>();
    const files = globSync(`${GRAPHS}/**/*.ts`, { cwd: repoRoot })
      .map((f) => String(f).split(path.sep).join('/'))
      .filter((f) => !f.includes('__tests__'));
    expect(files.length, 'no graph files found — fix this glob').toBeGreaterThan(40);

    for (const rel of files) {
      const src = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const m of src.matchAll(/reason: '([a-z_]+)'/g)) emitted.add(m[1]!);
    }
    const orphaned = CORRECTION_MESSAGE_KINDS.filter((kind) => !emitted.has(kind));
    expect(
      orphaned,
      'These kinds have a user-facing message but no def emits them any more — the message is ' +
        'dead and whatever replaced the reason corrects silently.'
    ).toEqual([]);
  });
});
