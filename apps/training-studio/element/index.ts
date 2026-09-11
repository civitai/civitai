// Entry for the <civitai-training-studio> custom-element bundle (`pnpm build:element`). Importing
// the component registers the element; the CSS is emitted alongside for the host page to <link>.
// shadow: 'none' means the stylesheet lands document-level in the HOST page, so the build scopes
// every selector to the element tag (vite.element.config.ts) — element.css carries the scoped
// import plus the element's own box baseline.
import './element.css';

// A host can inject this module more than once (dev cache-busting gives each mount a fresh module
// URL), and a second customElements.define for the tag throws NotSupportedError — so only import
// (and thereby register) the component when the tag is still undefined.
if (!customElements.get('civitai-training-studio')) {
  await import('./CivitaiTrainingStudio.svelte');
}

export type { StudioElementHost } from '$lib/element/backend';
export type { StudioLocation } from '$lib/host';
