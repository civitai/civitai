import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { defineConfig } from 'vite';

const SCOPE = 'civitai-training-studio';
const PORTAL = '[data-cts-portal]';

/** Rewrite one selector so it only applies inside the custom element. The element renders in the
 *  HOST page's light DOM (shadow: 'none'), so unscoped Tailwind preflight / theme rules would
 *  restyle the whole embedding page — the standalone shell is the only place the global form is
 *  correct. Document-level subjects collapse onto the element itself (it is the "page" of the
 *  embed). Scheme: dark is the DEFAULT — `.dark` gates become `:not(.light)` so a host opts into
 *  light by putting a `light` class on the element, which lets the shared theme's :root light
 *  tokens show through plus the `.light` palette remap in global.css. */
function scopeSelector(sel: string): string {
  const s = sel.trim();
  if (s === SCOPE || s.startsWith(`${SCOPE}.`) || s.startsWith(`${SCOPE} `)) return s;
  if (s === ':root' || s === 'html' || s === 'body' || s === ':host') return SCOPE;
  // `html.buzz-green` (the shell's Buzz-mode class on <html>) keeps the ancestor gate so a host
  // page could still flip it, while the declared vars land on the element.
  const docCompound = s.match(/^(html|body|:root)([.:[][^ >+~]*)$/);
  if (docCompound) return `html${docCompound[2]} ${SCOPE}`;
  if (s === '.dark') return `${SCOPE}:not(.light)`;
  if (s.startsWith('.dark ')) return `${SCOPE}:not(.light) ${s.slice('.dark '.length)}`;
  if (s.startsWith('.dark.')) return `${SCOPE}:not(.light)${s.slice('.dark'.length)}`;
  if (s === '.light') return `${SCOPE}.light`;
  if (s.startsWith('.light ')) return `${SCOPE}.light ${s.slice('.light '.length)}`;
  if (s.startsWith('.light.')) return `${SCOPE}.light${s.slice('.light'.length)}`;
  return `${SCOPE} ${s}`;
}

/** Every scoped rule also targets `[data-cts-portal]` — the element's body-level portal root for
 *  dialogs/selects/tooltips (element/CivitaiTrainingStudio.svelte). Portalled content sits outside
 *  the element, so the element-rooted rules — including the :root/html CSS vars collapsed onto the
 *  element, which do NOT inherit across to a body-level node — would never reach it. Every scoped
 *  selector contains SCOPE exactly once, so the variant is a plain substitution (the `html.buzz-green
 *  SCOPE` ancestor form becomes `html.buzz-green [data-cts-portal]`). */
function scopeSelectors(sel: string): string[] {
  const scoped = scopeSelector(sel);
  return [scoped, scoped.replace(SCOPE, PORTAL)];
}

/** Skip selector rewriting where selectors aren't element queries (keyframe steps). */
function insideKeyframes(rule: { parent?: { type?: string; name?: string } }): boolean {
  let node = rule.parent;
  while (node) {
    if (node.type === 'atrule' && /keyframes$/.test(node.name ?? '')) return true;
    node = (node as { parent?: { type?: string; name?: string } }).parent;
  }
  return false;
}

type LayerAtRule = {
  nodes?: object[];
  replaceWith: (nodes: object[]) => void;
  remove: () => void;
};

type ScopableRule = {
  selectors: string[];
  parent?: object;
  nodes?: Array<{ type: string; prop?: string }>;
  append: (decl: { prop: string; value: string }) => void;
};

const scopeToElement = {
  postcssPlugin: 'scope-to-element',
  OnceExit(root: {
    walkRules: (cb: (rule: ScopableRule) => void) => void;
    walkAtRules: (name: string, cb: (atRule: LayerAtRule) => void) => void;
  }) {
    // Unwrap every @layer, hoisting children in place (and dropping bare `@layer a, b;`
    // statements): the embedding page's own Tailwind emits same-named utilities UNLAYERED, and
    // unlayered author CSS beats layered — so host rules would override the element's scoped ones.
    // Tailwind already emits theme→base→components→utilities in source order, so the internal
    // cascade survives; the tag prefix then out-specifics the host's bare classes. Loop because
    // replaceWith can move a nested @layer past the walker's cursor.
    let unwrapped = true;
    while (unwrapped) {
      unwrapped = false;
      root.walkAtRules('layer', (atRule) => {
        unwrapped = true;
        if (atRule.nodes?.length) atRule.replaceWith(atRule.nodes);
        else atRule.remove();
      });
    }
    root.walkRules((rule) => {
      if (insideKeyframes(rule)) return;
      rule.selectors = rule.selectors.flatMap(scopeSelectors);
      // Tailwind v4 moves translate/rotate/scale onto the composable CSS properties, but the
      // EMBEDDING page's Tailwind v3 utilities with the same class names (`.-translate-x-1/2`
      // etc.) set `transform:` — and both apply to our nodes, so a centered dialog gets shifted
      // twice (measured: -50% applied via transform AND translate). Neutralize the host's
      // transform wherever we set the composable properties; keyframe animations still win over
      // this normal declaration, so tw-animate enter/exit transforms are unaffected.
      const decls = (rule.nodes ?? []).filter((n) => n.type === 'decl');
      const sets = (prop: string) => decls.some((d) => d.prop === prop);
      if ((sets('translate') || sets('rotate') || sets('scale')) && !sets('transform')) {
        rule.append({ prop: 'transform', value: 'none' });
      }
    });
  },
};

// Builds element/ into the <civitai-training-studio> custom-element bundle, output under
// static/element/ so the SvelteKit dev server serves it at /element/* for an embedding host to
// load. Plain vite+svelte (customElement compile), NOT SvelteKit — the element must not depend on
// the Kit runtime; flow code reaches everything host-specific through $lib/host.
export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte({
      configFile: false,
      preprocess: vitePreprocess(),
      compilerOptions: { customElement: true },
    }),
  ],
  css: {
    postcss: { plugins: [scopeToElement] },
  },
  resolve: {
    alias: { $lib: path.resolve(__dirname, 'src/lib') },
  },
  build: {
    // The entry's define guard uses top-level await, which Vite's default target rejects.
    target: 'es2022',
    lib: {
      entry: path.resolve(__dirname, 'element/index.ts'),
      formats: ['es'],
      fileName: () => 'civitai-training-studio.js',
    },
    outDir: 'static/element',
    emptyOutDir: true,
    rollupOptions: {
      output: { assetFileNames: 'civitai-training-studio[extname]' },
    },
  },
});
