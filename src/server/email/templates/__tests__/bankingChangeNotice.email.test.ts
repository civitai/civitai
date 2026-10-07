import { describe, expect, it } from 'vitest';
import { getBankingChangeNoticeHtml } from '~/server/email/templates/bankingChangeNotice.email';
import { getBaseUrl } from '~/server/utils/url-helpers';

describe('getBankingChangeNoticeHtml', () => {
  const html = getBankingChangeNoticeHtml('<b>Ann</b>');

  it('addresses the reader with their username escaped', () => {
    expect(html).toContain('Hi &lt;b&gt;Ann&lt;/b&gt;,');
    expect(html).not.toContain('{username}');
  });

  it('points images and links at absolute site URLs', () => {
    const base = getBaseUrl();
    expect(html).toContain(`src="${base}/images/email/banking-change-notice/november-example.jpg"`);
    expect(html).toContain(`src="${base}/images/email/banking-change-notice/monthly-limit.jpg"`);
    expect(html).toContain(`href="${base}/user/buzz-dashboard"`);
    expect(html).not.toMatch(/(src|href)="\//);
  });

  it('renders the bankable table with inline styles', () => {
    expect(html).toContain('<table style="border-collapse: collapse; width: 100%;">');
    expect(html).toMatch(/<td style="[^"]+">New generation compensation<\/td>/);
  });
});
