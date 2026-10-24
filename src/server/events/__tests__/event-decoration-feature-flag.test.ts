import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_DECORATION_DEFINITIONS } from '~/shared/constants/event-decoration.constants';

/**
 * The home blocks ask for a viewer's preview hats only when `definition.featureFlag` is on for
 * them; the server lets a viewer into the preview on the event's own `featureFlag`. Two spellings
 * of one rule, so they are pinned together, for every decoration with a preview: one naming no flag,
 * or a different one, would show its preview hats to nobody, or ask for them for the wrong viewers.
 */
const eventDir = path.resolve(__dirname, '..');

async function loadEventFiles() {
  const files = readdirSync(eventDir).filter(
    (f) => f.endsWith('.event.ts') && f !== 'base.event.ts'
  );
  const modules = await Promise.all(files.map((f) => import(path.join(eventDir, f))));
  return modules.flatMap((m) =>
    Object.values(m as Record<string, unknown>).filter(
      (x): x is { name: string; featureFlag?: string } =>
        !!x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string'
    )
  );
}

const previewed = EVENT_DECORATION_DEFINITIONS.filter((d) => d.previewFrom);

describe('event decoration feature flags', () => {
  it('has a previewed decoration to check', () => {
    expect(previewed.length).toBeGreaterThan(0);
  });

  it.each(previewed.map((d) => [d.event, d] as const))(
    '%s names the flag of the event it decorates',
    async (event, definition) => {
      const match = (await loadEventFiles()).find((e) => e.name === event);
      expect(match, `no *.event.ts exports the event ${event}`).toBeDefined();
      expect(definition.featureFlag, 'a previewed decoration needs its event flag').toBeDefined();
      expect(definition.featureFlag).toBe(match?.featureFlag);
    }
  );
});
