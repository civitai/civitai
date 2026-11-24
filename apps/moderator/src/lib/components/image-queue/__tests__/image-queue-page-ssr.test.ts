// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETRACTED_REFUSED } from '$lib/held-media';

/**
 * Each image queue kind's page, server-rendered with a normal card and a withheld one. This config has
 * no Svelte plugin, so the page is compiled here with its child components stubbed: a stub grid that
 * draws every card through the page's own `card` snippet, and the real PromptHighlight.
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
// Some stubs are drawn with no props at all, so nothing here destructures them.
const PASS = `<script>const props = $props();</script>{@render props?.children?.()}`;
const STUBS: Record<string, string> = {
  Empty: '',
  Pass: PASS,
  // Draws the media url a card would load, so a test can see whose media reached the page.
  Media: `<script>const props = $props();</script><img alt="" src={props.item.url} />`,
};

// Inside src, not node_modules: Vitest transforms only files outside node_modules, and the page's
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

/** `source` with every import this harness can't load replaced: the grid and PromptHighlight by
 *  their compiled selves, other components by stubs, `$app` modules by inert values. */
function stubImports(source: string): string {
  return source
    .replace(/import \{ enhance \} from '\$app\/forms';/, 'const enhance = () => {};')
    .replace(/import \{ goto \} from '\$app\/navigation';/, 'const goto = () => {};')
    .replace(
      /import \{ page(?: as (\w+))? \} from '\$app\/state';/,
      (_, as) => `const ${as ?? 'page'} = { url: new URL('https://mod.test/images') };`
    )
    .replace(
      /import \* as (\w+) from '@civitai\/ui\/[^']+';/g,
      "import * as $1 from './Namespace.js';"
    )
    .replace(
      /import \{ ([\w, ]+) \} from '(?:@civitai\/ui\/components|@tabler\/icons-svelte)[^']*';/g,
      (_, names) =>
        names
          .split(',')
          .map((n: string) => `import ${n.trim()} from './Pass.js';`)
          .join('\n')
    )
    .replace(/import ImageQueueGrid from '[^']+';/, "import ImageQueueGrid from './Grid.js';")
    .replace(
      /import PromptHighlight from '[^']+';/,
      "import PromptHighlight from './PromptHighlight.js';"
    )
    .replace(
      /import CdnOrRetractedMedia from '[^']+';/,
      "import CdnOrRetractedMedia from './Media.js';"
    )
    .replace(/import (\w+) from '[^']+\.svelte';/g, "import $1 from './Empty.js';");
}

let Page: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const [name, source] of Object.entries(STUBS)) emit(name, source);
  writeFileSync(
    path.join(work, 'Namespace.js'),
    "export { default as Root, default as Trigger, default as Content } from './Pass.js';"
  );
  const read = (rel: string) => readFileSync(path.join(LIB, rel), 'utf8');
  emit('Grid', stubImports(read('components/ImageQueueGrid.svelte')));
  emit('PromptHighlight', stubImports(read('components/PromptHighlight.svelte')));
  emit('Page', stubImports(read('components/image-queue/ImageQueuePage.svelte')));
  Page = (await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'Page.js')).href)).default;
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

const PROMPT = 'a lighthouse at dusk, oil painting';
const NORMAL = 990000301;
const WITHHELD = 990000302;

/** A card as the queue's load sends it, for an R image nothing withholds. */
const card = (id: number) => ({
  id,
  url: `key-${id}`,
  type: 'image' as const,
  name: null,
  width: 512,
  height: 512,
  nsfwLevel: 4,
  userId: 9,
  username: 'owner',
  profilePicture: null,
  createdAt: new Date('2026-11-24T00:00:00Z'),
  ingestion: 'Scanned',
  needsReview: 'minor',
  blockedFor: null,
  ruleBlocked: false,
  minor: false,
  poi: false,
  acceptableMinor: false,
  modelRestricted: false,
  tosReason: null,
  removedAt: null,
  moderatorUsername: null,
  capture: null,
  tags: [],
  reports: [],
  reviewTags: [],
  model3d: null,
  approvedAppeal: null,
  ruleDefinition: null,
  ruleReason: null,
  promptHighlight: {
    includesInappropriate: false,
    prompt: [{ text: PROMPT, category: 'minor' }],
    negativePrompt: null,
    hasHighlights: true,
  },
  report: {
    id: id + 1000,
    reason: 'TOSViolation',
    details: null,
    count: 1,
    createdAt: new Date('2026-11-24T00:00:00Z'),
    username: 'reporter',
    agentFiled: false,
  },
  appeal: {
    id: id + 2000,
    message: 'please review',
    createdAt: new Date(),
    username: 'owner',
    userId: 9,
  },
  restricted: false as const,
});

/** The same card withheld from this moderator: the fields `withheldCards` blanks. */
const withheld = (id: number) => ({
  ...card(id),
  url: '',
  type: null,
  width: null,
  height: null,
  blockedFor: null,
  needsReview: null,
  tosReason: null,
  appeal: { ...card(id).appeal, message: '' },
  restricted: true as const,
  promptHighlight: null,
  ruleDefinition: null,
  ruleReason: null,
  reviewTags: [],
  report: { ...card(id).report, reason: '', details: null },
});

const QUEUES = [
  ['minor', 'review-highlight'],
  ['remixSource', 'review-highlight'],
  ['reported', 'reported'],
  ['appeals', 'appeal'],
  ['newUser', 'review'],
  ['modRule', 'review'],
] as const;

function show(view: string, kind: string, items: object[] = [card(NORMAL), withheld(WITHHELD)]) {
  const body = render(Page, {
    props: {
      data: {
        title: view,
        civitaiUrl: 'https://civitai.test',
        canAct: true,
        view,
        kind,
        limit: 50,
        level: 31,
        wide: true,
        tagIds: [],
        excludedTagIds: [],
        tagOptions: [],
        items,
        nextCursor: undefined,
        singleReport: null,
        agentFilter: null,
        capturesOnly: false,
        userId: null,
      },
      form: null,
    },
  }).body;
  document.body.innerHTML = body;
  return body;
}

describe.each(QUEUES)('the %s queue page, with a withheld card', (view, kind) => {
  it('renders the normal card with its media, and the withheld one as not viewable', () => {
    show(view, kind);
    const media = [...document.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(media).toEqual([`key-${NORMAL}`]);
    expect(document.body.textContent?.split(RETRACTED_REFUSED).length).toBe(2);
  });
});

describe('the review-highlight queues', () => {
  const prompts = () => (document.body.textContent ?? '').split(PROMPT).length - 1;

  it.each(['minor', 'remixSource'])(
    "%s shows the normal card's prompt, and nothing of the withheld one's",
    (view) => {
      show(view, 'review-highlight', [card(NORMAL)]);
      const alone = prompts();
      expect(alone).toBeGreaterThan(0);
      show(view, 'review-highlight');
      expect(prompts()).toBe(alone);
    }
  );
});
