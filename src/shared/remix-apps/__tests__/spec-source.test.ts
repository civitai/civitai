import { parse, type Comment } from 'acorn';
import { describe, expect, it } from 'vitest';
import { remixSourceLiterals } from '~/server/services/remix-app-literals';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import { compileRemixApp } from '~/shared/remix-apps/compile';
import type { RemixAsk } from '~/shared/remix-apps/define';
import { dryRunRemixApp, firstAnswer } from '~/shared/remix-apps/mock-host';
import {
  remixDeclarativeSpecSchema,
  type RemixDeclarativeSpec,
} from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { remixSourceSpec, remixSpecToSource } from '~/shared/remix-apps/spec-source';

/** Strings a careless template would let out of a literal: quotes, escapes, comment and template ends. */
const AWKWARD = `"hi" it's \\n \\ \${ctx.source} */ //\u2028x\u2029y\nz`;

const FIXTURES: { slug: string; spec: RemixDeclarativeSpec }[] = [
  ...SEED_REMIX_APPS.flatMap(({ slug, spec }) => ('steps' in spec ? [{ slug, spec }] : [])),
  {
    slug: 'awkward-text',
    spec: {
      icon: 'pencil',
      engine: DEFAULT_ENGINE,
      asks: [
        {
          id: 'note',
          kind: 'text',
          prompt: `Note ${AWKWARD}`,
          maxLength: 200,
          optional: true,
          wrap: { before: `before ${AWKWARD} `, after: ` after ${AWKWARD}` },
        },
        {
          id: 'mood',
          kind: 'choice',
          prompt: `Mood ${AWKWARD}`,
          options: [
            { value: 'calm', label: `Calm ${AWKWARD}`, fragments: { tone: `soft ${AWKWARD}` } },
            { value: 'bold', label: 'Bold', fragments: { tone: `hard ${AWKWARD}` } },
            { value: 'constructor', label: 'Odd value', fragments: { tone: 'plain' } },
          ],
        },
      ],
      steps: [
        {
          kind: 'image',
          prompt: `{{tone}} first ${AWKWARD} {{note}}{{tone}}`,
          aspectRatio: '2:3',
          quantity: 2,
          input: 'source',
        },
        { kind: 'image', prompt: 'Again', aspectRatio: 'source', quantity: 1, input: 'previous' },
        { kind: 'upscale', scale: 2 },
      ],
    },
  },
].map(({ slug, spec }) => ({ slug, spec: remixDeclarativeSpecSchema.parse(spec) }));

const SOURCE = { imageId: 7, url: 'https://image.example/source.png', width: 1200, height: 800 };

/** The last option, so a fragment table read at the wrong index shows; any other ask its first answer. */
const lastOption = (spec: RemixAsk) =>
  spec.kind === 'choice' ? spec.options[spec.options.length - 1].value : firstAnswer(spec);

describe('remixSpecToSource', () => {
  it.each(FIXTURES.map((f) => [f.slug, f.spec] as const))(
    '%s: the module and its trace match the goldens, and every prompt text is a literal',
    async (slug, spec) => {
      const source = remixSpecToSource(spec);
      await expect(source).toMatchFileSnapshot(`./__goldens__/${slug}.js`);
      // The runner replays the module over this log (apps/storage-hook-runner) and must agree.
      const run = await dryRunRemixApp(
        compileRemixApp({ slug, name: slug, version: 1 }, spec),
        SOURCE,
        {
          answer: lastOption,
        }
      );
      await expect(JSON.stringify({ source: SOURCE, ...run }, null, 2) + '\n').toMatchFileSnapshot(
        `./__goldens__/${slug}.trace.json`
      );

      // What the save audit reads: every piece of author text that can reach a prompt.
      const literals = remixSourceLiterals(source)!;
      const expected = [
        ...spec.asks.flatMap((ask) => [
          ask.prompt,
          ...(ask.kind === 'text' && ask.wrap ? [ask.wrap.before, ask.wrap.after] : []),
          ...(ask.kind === 'choice' ? ask.options.flatMap((o) => Object.values(o.fragments)) : []),
        ]),
        ...spec.steps.flatMap((step) =>
          step.kind === 'image' ? step.prompt.split(/\{\{[^{}]*\}\}/) : []
        ),
      ].filter((text) => text.trim());
      expect(expected.filter((text) => !literals.prompts.includes(text))).toEqual([]);
      const labels = spec.asks.flatMap((ask) =>
        ask.kind === 'choice' ? ask.options.map((o) => o.label) : []
      );
      expect(labels.filter((label) => !literals.all.has(label))).toEqual([]);
    }
  );

  it('keeps spec text out of comments and identifiers, and reads the spec back exactly', () => {
    const { spec } = FIXTURES.find((f) => f.slug === 'awkward-text')!;
    const source = remixSpecToSource(spec);
    const comments: Comment[] = [];
    const identifiers = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if ((node as { type?: string }).type === 'Identifier')
        identifiers.add((node as { name: string }).name);
      Object.values(node).forEach((child) =>
        Array.isArray(child) ? child.forEach(walk) : walk(child)
      );
    };
    walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments }));

    expect(comments.map((c) => c.value)).toEqual([' remix-app-creator template v1']);
    // Indexed names and the runner's API only: none comes from the spec.
    const fixed =
      /^(?:[tco]\d+|SPEC|defineRemixApp|run|ctx|ask|workflow|source|images|Math|max|indexOf|trim|kind|prompt|maxLength|optional|options|image|scale|aspectRatio|quantity)$/;
    expect([...identifiers].filter((name) => !fixed.test(name))).toEqual([]);
    expect(remixSourceSpec(source)).toEqual({ spec, version: 1 });
  });

  it('refuses an image ask, which the sandbox cannot answer yet', () => {
    const spec = remixDeclarativeSpecSchema.parse({
      icon: 'camera',
      engine: DEFAULT_ENGINE,
      asks: [{ id: 'look', kind: 'image', prompt: 'Pick a reference' }],
      steps: [
        {
          kind: 'image',
          prompt: 'Use it',
          aspectRatio: 'source',
          quantity: 1,
          input: 'source',
          references: ['look'],
        },
      ],
    });
    expect(() => remixSpecToSource(spec)).toThrow('cannot ask for an image');
  });
});

describe('remixSourceSpec', () => {
  const { spec } = FIXTURES.find((f) => f.slug === 'awkward-text')!;
  const source = remixSpecToSource(spec);

  it('matches only the exact module its header spec builds', () => {
    expect(remixSourceSpec(source)?.version).toBe(1);
    // The body edited, the header left alone.
    expect(remixSourceSpec(source.replace('quantity: 2', 'quantity: 4'))).toBeNull();
    // The header's spec edited, the body left alone.
    expect(remixSourceSpec(source.replace('"quantity":2', '"quantity":4'))).toBeNull();
    expect(remixSourceSpec(source.replace('template v1', 'template v9'))).toBeNull();
    expect(remixSourceSpec(source + '\n')).toBeNull();
    expect(
      remixSourceSpec('export default defineRemixApp({ async run(ctx) { return []; } });')
    ).toBeNull();
  });
});
