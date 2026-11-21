import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Keeps Tailwind's preflight (`* { margin: 0; padding: 0; border: 0 solid }`) off Civitai Elements
 * and the Studio's own `studio-*` elements. A page rule beats a shadow root's `:host` rule whatever
 * its specificity, so the reset otherwise wipes each element's own padding and border. The tag
 * list comes from the kit's manifest and the `TAG` constants in src/lib/elements, so a new element
 * is covered without editing this.
 */
function elementTags(): string[] {
  const require = createRequire(import.meta.url);
  const manifest = require('@civitai/components/custom-elements.json') as {
    modules: { declarations?: { tagName?: string }[] }[];
  };
  const kitTags = manifest.modules.flatMap((m) =>
    (m.declarations ?? []).flatMap((d) => (d.tagName ? [d.tagName] : []))
  );
  const elementsDir = path.resolve(import.meta.dirname, 'src/lib/elements');
  const studioTags = readdirSync(elementsDir)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => {
      const match = /const TAG = '(studio-[a-z-]+)'/.exec(
        readFileSync(path.join(elementsDir, file), 'utf8')
      );
      return match ? [match[1]!] : [];
    });
  return [...new Set([...kitTags, ...studioTags])].sort();
}

export function kitElementResetExemption() {
  const universal = `*:not(${elementTags().join(', ')})`;
  return {
    postcssPlugin: 'kit-element-reset-exemption',
    Rule(rule: { selectors: string[] }) {
      if (rule.selectors.includes('*'))
        rule.selectors = rule.selectors.map((selector) =>
          selector === '*' ? universal : selector
        );
    },
  };
}
