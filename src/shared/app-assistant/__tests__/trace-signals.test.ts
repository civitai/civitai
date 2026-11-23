import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeTraceSignals,
  docsTopicOf,
  themeSignals,
  transcriptSignals,
  TRACE_SIGNALS_VERSION,
  type TranscriptLike,
} from '~/shared/app-assistant/trace-signals';

/**
 * The fixtures under `fixtures/page-elements` are the `page-elements` template's own files, copied
 * verbatim from the CLI's `internal/scaffold/templates/page-elements` (commit fda27eb82bc0) with
 * `.tmpl` replaced by `.txt` so nothing here typechecks or runs them. They are what an app that
 * never touched its theme submits.
 */
const FIXTURES = fileURLToPath(new URL('./fixtures/page-elements', import.meta.url));

function template(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(FIXTURES, path).replace(/\.txt$/, ''), readFileSync(path, 'utf8'));
    }
  };
  walk(FIXTURES);
  return files;
}

/** The template with `path` replaced (or added) by `text`. */
const withFile = (path: string, text: string) => new Map([...template(), [path, text]]);
const appended = (path: string, extra: string) =>
  withFile(path, `${template().get(path) ?? ''}\n${extra}\n`);

describe('themeSignals', () => {
  it('the untouched page-elements template keeps the default theme', () => {
    expect(themeSignals(template())).toEqual({
      themeCustomized: false,
      theme: {
        tokenOverrides: [],
        customColorCount: 0,
        customColorFiles: [],
        usesThemePackage: true,
        stylingDependencies: [],
        // index.html, vite.config.ts, src/index.css, src/main.ts, src/block.ts, src/dev-embed.ts
        filesScanned: 6,
      },
    });
  });

  it('setting a --civitai-* token in CSS customises the theme', () => {
    const { themeCustomized, theme } = themeSignals(
      appended('src/index.css', ':root { --civitai-color-primary: var(--brand-a); }')
    );
    expect(themeCustomized).toBe(true);
    expect(theme.tokenOverrides).toEqual(['--civitai-color-primary']);
    expect(theme.customColorCount).toBe(0);
  });

  it('a token set from script (setProperty) is counted too', () => {
    const { theme } = themeSignals(
      appended(
        'src/block.ts',
        "document.documentElement.style.setProperty('--civitai-color-body', next);"
      )
    );
    expect(theme.tokenOverrides).toEqual(['--civitai-color-body']);
  });

  it('reading a token (var(--civitai-…)) is not setting it', () => {
    const { themeCustomized } = themeSignals(
      appended('src/index.css', '.card { color: var(--civitai-color-text-dimmed); }')
    );
    expect(themeCustomized).toBe(false);
  });

  it('a colour of its own, in CSS, counts once per declaration and names its file', () => {
    const { themeCustomized, theme } = themeSignals(
      appended(
        'src/app.css',
        '.hero { background: linear-gradient(#7b2ff7, rgb(241 7 163)); }\n.tag { color: teal; border: 1px solid #333; }'
      )
    );
    expect(themeCustomized).toBe(true);
    expect(theme.customColorCount).toBe(3);
    expect(theme.customColorFiles).toEqual(['src/app.css']);
  });

  it('the template’s own boot-skeleton literals are not colours of the app’s own', () => {
    // index.html carries #1a1b1e, #ffffff, #2c2e33 and #e9ecef; a new literal there does count.
    const { theme } = themeSignals(
      withFile(
        'index.html',
        template().get('index.html')!.replace('background: #1a1b1e;', 'background: #0b0c10;')
      )
    );
    expect(theme.customColorCount).toBe(1);
    expect(theme.customColorFiles).toEqual(['index.html']);
  });

  it('a JS style object and Tailwind colour classes count as colours of its own', () => {
    const { theme } = themeSignals(
      appended(
        'src/block.ts',
        'el.innerHTML = `<div class="bg-purple-600 text-[#f0abfc]"></div>`;\nObject.assign(card.style, { backgroundColor: \'hsl(280 80% 50%)\' });'
      )
    );
    expect(theme.customColorCount).toBe(3);
    expect(theme.customColorFiles).toEqual(['src/block.ts']);
  });

  it('tests, the dev harness, dependencies and build output are not the app’s styling', () => {
    const colored = '.x { color: #abcdef; --civitai-color-primary: red; }';
    const files = new Map(template());
    for (const path of [
      'test/theme.test.ts',
      'src/dev/overlay.css',
      'node_modules/lib/index.css',
      'dist/assets/index.css',
      'src/thing.spec.tsx',
    ])
      files.set(path, colored);
    expect(themeSignals(files).themeCustomized).toBe(false);
  });

  it('reports styling dependencies without judging on them', () => {
    const pkg = JSON.parse(template().get('package.json')!);
    pkg.devDependencies = { ...pkg.devDependencies, tailwindcss: '^4.0.0', '@mantine/core': '8' };
    const { themeCustomized, theme } = themeSignals(withFile('package.json', JSON.stringify(pkg)));
    expect(theme.stylingDependencies).toEqual(['@mantine/core', 'tailwindcss']);
    expect(themeCustomized).toBe(false);
  });

  it('nothing to scan is nothing to judge: null', () => {
    expect(themeSignals(new Map([['README.md', '# app']])).themeCustomized).toBeNull();
  });
});

// Pairwise-distinct counts, models, Buzz, paths and topics.
function call(toolName: string, input: unknown) {
  return { type: 'tool-call', toolCallId: `${toolName}-${JSON.stringify(input)}`, toolName, input };
}
const CHAT_A: TranscriptLike = {
  model: 'model-picked-a',
  turns: [
    {
      assistant: {
        buzz: 12,
        messages: [
          { role: 'user', content: 'make it' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'ok' },
              call('read_docs', { url: 'https://developer.civitai.com/apps/theme/' }),
              call('sandbox__write_file', { path: 'src/block.ts', content: 'x' }),
            ],
          },
        ],
      },
    },
    {
      assistant: {
        buzz: 5.5,
        messages: [
          {
            role: 'assistant',
            content: [
              call('read_docs', { url: 'https://developer.civitai.com/apps/sdk' }),
              call('read_docs', { url: 'https://developer.civitai.com/apps/theme' }),
              call('sandbox__edit_file', { path: 'src/index.css', edits: [] }),
            ],
          },
        ],
      },
    },
  ],
};
const CHAT_B: TranscriptLike = {
  turns: [
    {
      assistant: {
        messages: [
          {
            role: 'assistant',
            content: [
              call('sandbox__delete_path', { path: 'scratch/notes.md' }),
              call('sandbox__write_file', { path: 'src/block.ts', content: 'y' }),
              call('report_ready', {}),
            ],
          },
        ],
      },
    },
    { assistant: null },
    {},
  ],
};

describe('transcriptSignals', () => {
  it('sums turns and Buzz, counts tools, and lists docs topics and edited files', () => {
    expect(transcriptSignals([CHAT_A, CHAT_B], 'model-default-z')).toEqual({
      sessionCount: 2,
      turnCount: 5,
      buzzTotal: 17.5,
      models: ['model-default-z', 'model-picked-a'],
      toolCallCounts: {
        read_docs: 3,
        sandbox__write_file: 2,
        sandbox__edit_file: 1,
        sandbox__delete_path: 1,
        report_ready: 1,
      },
      readDocsTopics: ['/apps/theme', '/apps/sdk'],
      editedFiles: ['scratch/notes.md', 'src/block.ts', 'src/index.css'],
    });
  });

  it('no sessions is all zeros', () => {
    expect(transcriptSignals([], 'm')).toEqual({
      sessionCount: 0,
      turnCount: 0,
      buzzTotal: 0,
      models: [],
      toolCallCounts: {},
      readDocsTopics: [],
      editedFiles: [],
    });
  });

  it('a docs address without a scheme, or one that does not parse, is kept as a topic', () => {
    expect(docsTopicOf('civitai.com/agent-onboarding')).toBe('/agent-onboarding');
    expect(docsTopicOf('https://developer.civitai.com/')).toBe('/');
  });
});

describe('computeTraceSignals', () => {
  it('carries its version with both halves', () => {
    const signals = computeTraceSignals({
      files: template(),
      transcripts: [CHAT_B],
      defaultModel: 'model-default-z',
    });
    expect(signals.signalsVersion).toBe(TRACE_SIGNALS_VERSION);
    expect(signals.themeCustomized).toBe(false);
    expect(signals.sessionCount).toBe(1);
    expect(signals.editedFiles).toEqual(['scratch/notes.md', 'src/block.ts']);
  });
});
