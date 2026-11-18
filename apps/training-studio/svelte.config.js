import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Civitai Elements render a real <button>/<input> in their shadow root, which handles keys and roles;
// Svelte's a11y checks can't see inside and read every <civitai-*> tag as a static <div>.
const ELEMENT_A11Y_FALSE_POSITIVES = new Set([
  'a11y_click_events_have_key_events',
  'a11y_no_static_element_interactions',
]);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  compilerOptions: {
    warningFilter: (warning) =>
      !(ELEMENT_A11Y_FALSE_POSITIVES.has(warning.code) && warning.message.includes('<civitai-')),
  },
  kit: {
    adapter: adapter(),
  },
};

export default config;
