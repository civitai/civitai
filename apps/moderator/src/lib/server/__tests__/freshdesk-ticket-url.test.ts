import { afterEach, describe, expect, it } from 'vitest';
import { freshdeskHost, freshdeskTicketUrl } from '../freshdesk.service';

describe('freshdeskTicketUrl', () => {
  const saved = process.env.FRESHDESK_DOMAIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.FRESHDESK_DOMAIN;
    else process.env.FRESHDESK_DOMAIN = saved;
  });

  it('falls back to the default domain when none is configured', () => {
    delete process.env.FRESHDESK_DOMAIN;
    expect(freshdeskTicketUrl('18234')).toBe('https://civitai.freshdesk.com/a/tickets/18234');
  });

  it('uses the configured domain', () => {
    process.env.FRESHDESK_DOMAIN = 'help.example.test';
    expect(freshdeskTicketUrl(18234)).toBe('https://help.example.test/a/tickets/18234');
  });

  it('takes an explicit domain over the configured one', () => {
    process.env.FRESHDESK_DOMAIN = 'help.example.test';
    expect(freshdeskTicketUrl('7', 'other.example.test')).toBe(
      'https://other.example.test/a/tickets/7'
    );
  });

  it('tolerates a domain configured WITH a scheme or trailing slash', () => {
    expect(freshdeskTicketUrl('7', 'https://x.example.test/')).toBe(
      'https://x.example.test/a/tickets/7'
    );
    expect(freshdeskHost('http://x.example.test')).toBe('x.example.test');
  });

  it('encodes the id — it is a path segment', () => {
    expect(freshdeskTicketUrl('1/2', 'x.example.test')).toBe(
      'https://x.example.test/a/tickets/1%2F2'
    );
  });
});
