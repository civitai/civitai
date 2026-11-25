// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETRACTED_REFUSED, WITHHELD_SOURCE } from '$lib/held-media';

/**
 * A remix trigger's card, server-rendered with its source withheld from this moderator and with an
 * open source that has no stored prompt. This config has no Svelte plugin, so the card is compiled
 * here with its child components stubbed, the media stub drawing the key it was handed.
 */
const require = createRequire(import.meta.url);
const SVELTE = path.dirname(require.resolve('svelte/package.json'));
const pkg = JSON.parse(readFileSync(path.join(SVELTE, 'package.json'), 'utf8'));
const { compile } = await import(pathToFileURL(path.join(SVELTE, 'src/compiler/index.js')).href);

function serverEntry(spec: string): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e.default;
  return pathToFileURL(path.join(SVELTE, e)).href;
}

const LIB = path.resolve(import.meta.dirname, '../../..');
const STUBS: Record<string, string> = {
  Empty: '',
  Pass: `<script>const props = $props();</script>{@render props?.children?.()}`,
  Media: `<script>const props = $props();</script><img alt="" src={props.src} />`,
};

// Inside src, not node_modules: Vitest transforms only files outside node_modules, and the card's
// `$lib` imports need its alias.
const work = mkdtempSync(path.join(import.meta.dirname, '.ssr-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function emit(name: string, source: string) {
  const { js } = compile(source, { generate: 'server', filename: `${name}.svelte` });
  writeFileSync(
    path.join(work, `${name}.js`),
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${serverEntry(s)}'`
    )
  );
}

function stubImports(source: string): string {
  return source
    .replace(
      /import \{ clipboardFeedback \} from '\$lib\/clipboard\.svelte';/,
      'const clipboardFeedback = () => ({ copy: async () => {}, copied: () => false, failed: () => false });'
    )
    .replace(
      /import \{ ([\w, ]+) \} from '(?:@civitai\/ui\/components|@tabler\/icons-svelte)[^']*';/g,
      (_, names) =>
        names
          .split(',')
          .map((n: string) => `import ${n.trim()} from './Pass.js';`)
          .join('\n')
    )
    .replace(/import EdgeMedia from '[^']+';/, "import EdgeMedia from './Media.js';")
    .replace(/import (\w+) from '[^']+\.svelte';/g, "import $1 from './Empty.js';");
}

let Card: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const [name, source] of Object.entries(STUBS)) emit(name, source);
  emit(
    'Card',
    stubImports(
      readFileSync(path.join(LIB, 'components/restrictions/TriageTriggerCard.svelte'), 'utf8')
    )
  );
  Card = (await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'Card.js')).href)).default;
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

const SOURCE = 990000401;
const KEY = 'withheld-source-key';

const draw = (source: Record<string, unknown>) =>
  render(Card, {
    props: {
      repeats: [
        {
          key: 't1',
          category: 'minor',
          prompt: 'a submitted prompt',
          origin: { remix: { imageId: SOURCE, verified: true, promptMatch: 'edited' } },
          inputImages: [],
        },
      ],
      index: 0,
      civitaiUrl: 'https://civitai.test',
      source,
      sourceState: 'loaded',
      selected: false,
      onToggle: () => {},
      recheck: undefined,
      recheckStatus: undefined,
    },
  }).body;

describe('a remix source on the trigger card', () => {
  it('says a withheld source is withheld, draws no media and offers no diff', () => {
    const body = draw({
      id: SOURCE,
      url: '',
      type: 'image',
      nsfwLevel: 1,
      prompt: null,
      restricted: true,
    });
    expect(body).toContain(WITHHELD_SOURCE);
    expect(body).toContain(RETRACTED_REFUSED);
    expect(body).not.toContain('no stored prompt');
    expect(body).not.toContain('<img');
  });

  it('says an open source with no prompt has none, and draws its media', () => {
    const body = draw({ id: SOURCE, url: KEY, type: 'image', nsfwLevel: 1, prompt: null });
    expect(body).toContain('The source image has no stored prompt to compare.');
    expect(body).not.toContain(WITHHELD_SOURCE);
    expect(body).toContain(KEY);
  });
});
