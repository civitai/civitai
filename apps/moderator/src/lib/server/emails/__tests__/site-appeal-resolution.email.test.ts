import { describe, expect, it } from 'vitest';
import { siteAppealResolutionEmail } from '../appeal-resolution.email';

const data = {
  to: 'a@test',
  username: '<b>eve</b>',
  category: 'Model' as const,
  approved: true,
  restored: true,
  appealUrl: 'https://civitai.test/appeal',
};

describe('siteAppealResolutionEmail', () => {
  it('escapes the username, which the appellant chose', () => {
    const html = siteAppealResolutionEmail.getHtml(data);
    expect(html).toContain('Hi &lt;b&gt;eve&lt;/b&gt;,');
    expect(html).not.toContain('<b>eve</b>');
  });

  it('carries the shared decision text and links to the appeal page', () => {
    const html = siteAppealResolutionEmail.getHtml(data);
    expect(html).toContain('We reviewed your appeal and republished your model.');
    expect(html).toContain('<a href="https://civitai.test/appeal">See the decision</a>');
  });
});
