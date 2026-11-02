import { describe, expect, it } from 'vitest';
import { closedPageHtml } from './closed-page';

describe('closedPageHtml', () => {
  it('says the gates are not open and offers a way out', () => {
    const html = closedPageHtml({ username: 'sir', civitaiUrl: 'https://civitai.com' });
    expect(html).toContain('not yet open');
    expect(html).toContain('href="/logout"');
    expect(html).toContain('href="https://civitai.com"');
  });

  it('escapes the username so a crafted name cannot inject markup', () => {
    const html = closedPageHtml({
      username: '<img src=x onerror=1>"',
      civitaiUrl: 'https://civitai.com',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('omits the account links when there is no username', () => {
    expect(closedPageHtml({ civitaiUrl: 'https://civitai.com' })).not.toContain('class="who"');
  });
});
