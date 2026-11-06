import { describe, expect, it } from 'vitest';
import { SYSTEM_REMIX_APPS } from '~/shared/constants/remix-apps.constants';
import { dryRunRemixApp } from '~/shared/remix-apps/mock-host';
import {
  RESTYLE_STYLES,
  SYSTEM_RUNTIME_APPS,
  restylePrompt,
} from '~/shared/remix-apps/system-apps';

const NO_TEXT = "Don't add any text";

describe('system remix app prompts forbid added text', () => {
  it.each(SYSTEM_REMIX_APPS.map((app) => [app.slug, app.prompt]))('%s', (_, prompt) => {
    expect(prompt).toContain(NO_TEXT);
  });

  it.each(SYSTEM_RUNTIME_APPS.map((app) => [app.slug, app] as const))(
    'runtime app %s',
    async (_, app) => {
      const source = { imageId: 7, url: 'https://image.example/s.png', width: 800, height: 800 };
      const { trace } = await dryRunRemixApp(app, source);
      const prompts = trace.flatMap((step) =>
        step.type === 'workflow' && step.request.kind === 'image' ? [step.request.prompt] : []
      );
      expect(prompts.length).toBeGreaterThan(0);
      for (const prompt of prompts) expect(prompt).toContain(NO_TEXT);
    }
  );

  it.each(RESTYLE_STYLES.map((s) => s.value))('restyle %s, with and without an extra', (style) => {
    expect(restylePrompt(style, '')).toContain(NO_TEXT);
    expect(restylePrompt(style, 'a red paper umbrella')).toMatch(/Don't add any text[^.]*\.$/);
  });

  it('ukiyo-e also forbids seals and stamps', () => {
    expect(restylePrompt('ukiyo-e', '')).toMatch(
      /Don't add any text, lettering, seals or stamps\.$/
    );
  });
});
