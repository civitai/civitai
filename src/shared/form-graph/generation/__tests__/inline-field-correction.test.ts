import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * The 22 family fields that declare their own schemas inline and now carry a hook.
 *
 * `no-uncorrected-constrained-def.test.ts` answers "does a hook exist"; this answers "does it
 * heal". Each row writes a value the field's own `output` REFUSES, the way ingestion does —
 * `store.set()`, which skips `input` — and asserts the store lands submittable rather than on
 * a blocked submit whose field the footer names and whose control shows nothing.
 *
 * `expectValid` is the assertion that matters. Checking the corrected value alone would pass
 * for a hook that returns something the output also refuses.
 *
 * 🔴 THIS IS THE INGESTION PATH ONLY — do not read it as switch coverage. A family field is
 * stored per family (`resolution@Flux3`, `resolution@Ming`), so changing the ecosystem does not
 * carry the value: the target reads its own empty bucket and takes its default, nothing is
 * corrected, and no note appears. Measured in a browser: picking Flux3 `4k` and switching to
 * Ming lands on `1K` silently, which is the designed per-family memory, not a missed
 * correction. These rows therefore write the value while the TARGET family is already active,
 * which is what remix/replay/preset do and the only shape a hook can see.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

type Store = ReturnType<typeof generationHub.createStore>;
const state = (store: Store) => store.getSnapshot().state as Record<string, unknown>;

function expectValid(store: Store, where: string) {
  const result = store.validate();
  expect(
    result.success,
    `${where}: a corrected value must not land unsubmittable — ${JSON.stringify(
      'errors' in result ? result.errors : {}
    )}`
  ).toBe(true);
}

/**
 * A row's `pin` is set first and alone, then the bad value: `coerce` is read from the
 * resolution as it stands BEFORE the patch, so a combined set would coerce against the
 * previous family's constraint and the five `coerce` rows would pass for the wrong reason.
 */
type Row = {
  name: string;
  pin: Record<string, unknown>;
  field: string;
  bad: unknown;
  /** The healed value, or a predicate when the family's default is derived. */
  expected: unknown | ((value: unknown) => boolean);
};

const ROWS: Row[] = [
  // ── enums: an out-of-set value falls back to the declared default ──────────
  {
    name: 'flux3 resolution',
    pin: { workflow: 'txt2img', ecosystem: 'Flux3', prompt: 'a cat' },
    field: 'resolution',
    bad: '8k',
    expected: '1k',
  },
  {
    name: 'ming resolution',
    pin: { workflow: 'txt2img', ecosystem: 'Ming', prompt: 'a cat' },
    field: 'resolution',
    bad: '8K',
    expected: '1K',
  },
  {
    name: 'qwen21 resolution',
    pin: { workflow: 'txt2img', ecosystem: 'Qwen21', prompt: 'a cat' },
    field: 'resolution',
    bad: '8K',
    expected: '1K',
  },
  {
    name: 'openai quality',
    pin: { workflow: 'txt2img', ecosystem: 'OpenAI', prompt: 'a cat' },
    field: 'quality',
    bad: 'ultra',
    expected: 'high',
  },
  {
    name: 'sora resolution',
    pin: { workflow: 'txt2vid', ecosystem: 'Sora2', prompt: 'a cat' },
    field: 'resolution',
    bad: '4320p',
    expected: '720p',
  },
  {
    name: 'veo3 version',
    pin: { workflow: 'txt2vid', ecosystem: 'Veo3', prompt: 'a cat' },
    field: 'version',
    bad: '9.9',
    expected: (v: unknown) => typeof v === 'string' && v !== '9.9',
  },
  {
    name: 'image preprocessKind',
    pin: { workflow: 'img2img:preprocess', images: [IMG()] },
    field: 'preprocessKind',
    bad: 'not-a-kind',
    expected: 'canny',
  },
];

function IMG() {
  return { url: 'https://image.civitai.com/x.png', width: 8, height: 8 };
}

// Sibling families spell the same option differently — Flux3 is lowercase, Ming and Qwen 2.1
// are uppercase — so the fallback used to drop a remix from the 2K the user picked to 1k on a
// family that HAS 2k. Respelling keeps the choice, and is silent because nothing observable
// changed.
describe('an option that differs only in spelling is mapped, not dropped', () => {
  it.each([
    ['Flux3', '2K', '2k'],
    ['Flux3', '1K', '1k'],
    ['Ming', '2k', '2K'],
    ['Qwen21', '2k', '2K'],
  ])('%s keeps %s as %s', (ecosystem, incoming, kept) => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img', ecosystem, prompt: 'a cat' });
    store.set({ resolution: incoming });

    expectValid(store, 'resolution');
    expect(state(store).resolution).toBe(kept);
  });

  // NEGATIVE CONTROL: a tier the family genuinely lacks still falls back, so the respell
  // is not just accepting everything.
  it('a tier the family does not have still falls back to the default', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img', ecosystem: 'Ming', prompt: 'a cat' });
    store.set({ resolution: '4k' });

    expectValid(store, 'resolution');
    expect(state(store).resolution).toBe('1K');
  });
});
describe('an inline field heals a trusted write it would otherwise refuse', () => {
  it.each(ROWS)('$name', ({ pin, field, bad, expected }) => {
    const store = generationHub.createStore({ ext: EXT });
    store.set(pin);

    // The field has to exist for this pin, or the row is asserting nothing.
    expect(store.getField(field), `${field} is not mounted for this pin`).toBeDefined();

    store.set({ [field]: bad });
    expectValid(store, field);

    const got = state(store)[field];
    if (typeof expected === 'function')
      expect((expected as (v: unknown) => boolean)(got)).toBe(true);
    else expect(got).toBe(expected);
  });

  // The `coerce` rows, separated because what makes them correct is WHERE they run: a
  // `correct` on any of these would also fire on the server parse, where the input carries
  // no bound — turning a 400 into a silent normalise-and-bill on a billed path.
  describe('permissive-input fields truncate or clamp in `coerce`', () => {
    it('ace title truncates to its cap', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({
        workflow: 'txt2music',
        ecosystem: 'Ace',
        aceAudioMode: 'custom',
        prompt: 'a tune',
        musicDescription: 'a calm piano piece',
      });
      expect(
        store.getField('title'),
        'title is not mounted — the row asserts nothing'
      ).toBeDefined();
      store.set({ title: 'x'.repeat(500) });
      expectValid(store, 'title');
      expect((state(store).title as string).length).toBe(100);
    });

    it('ace bpm clamps into range', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({
        workflow: 'txt2music',
        ecosystem: 'Ace',
        aceAudioMode: 'custom',
        prompt: 'a tune',
        musicDescription: 'a calm piano piece',
      });
      const meta = store.getField('bpm')?.meta as { min: number; max: number } | undefined;
      expect(meta, 'the field is not mounted — the row asserts nothing').toBeDefined();
      store.set({ bpm: meta!.max + 1000 });
      expectValid(store, 'bpm');
      expect(state(store).bpm).toBe(meta!.max);
    });

    it('ace duration clamps into range', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2music', ecosystem: 'Ace', prompt: 'a tune' });
      const meta = store.getField('duration')?.meta as { min: number; max: number } | undefined;
      expect(meta, 'the field is not mounted — the row asserts nothing').toBeDefined();
      store.set({ duration: meta!.max + 1000 });
      expectValid(store, 'duration');
      expect(state(store).duration).toBe(meta!.max);
    });
  });
});
