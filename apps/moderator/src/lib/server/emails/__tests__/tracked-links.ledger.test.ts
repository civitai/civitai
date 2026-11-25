import { afterEach, describe, expect, it } from 'vitest';
import { setEmailLinkTracker, type EmailLinkSend } from '@civitai/email';

// The template ledger: every email this app renders, the links it sends to the main app for
// tracking, and the HTML it goes out with. A new template fails the completeness check until it is
// listed here, with its links (and `oneTimeTokenLinks` when they carry a single-use token).
const modules = import.meta.glob('../*.email.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;
type Template = {
  template: string;
  oneTimeTokenLinks: boolean;
  getTrackedHtml: (data: unknown, sendId: string, tags?: { userId?: number }) => Promise<string>;
};
const templates = Object.values(modules)
  .flatMap((m) => Object.values(m))
  .filter((v): v is Template => typeof (v as Template)?.getTrackedHtml === 'function');
const byKey = new Map(templates.map((t) => [t.template, t]));

const SEND_ID = '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b';
const TOS = 'https://civitai.com/content/tos';
// The shared shell's links after a template's own: the socials (off the site), then its page
// footer's site links.
const SHELL_LINKS = [
  'https://discord.gg/civitai',
  'https://twitter.com/HelloCivitai',
  'https://www.instagram.com/hellocivitai/',
  'https://www.youtube.com/@civitai',
  'https://reddit.com/r/civitai',
  'https://civitai.com/content/tos',
  'https://civitai.com/content/privacy',
  'https://civitai.com/support',
];

// Per template: its data, and every link it carries in document order, each marked with the
// position the main app numbers it at (null: off the site, so it comes back as written).
const LEDGER: Record<
  string,
  { oneTimeTokenLinks: boolean; data: unknown; userId: number; links: [string, number | null][] }
> = {
  appealResolution: {
    oneTimeTokenLinks: false,
    userId: 7,
    data: {
      to: 'appellant@example.test',
      username: 'eve',
      approved: false,
      items: [
        { url: 'https://civitai.com/images/1', label: 'Image #1' },
        { url: 'https://civitai.red/images/2', label: 'Image #2' },
        { label: 'Image #3' },
      ],
    },
    links: [
      ['https://civitai.com/images/1', 1],
      ['https://civitai.red/images/2', null],
      [TOS, 2],
      ...shell(3),
    ],
  },
  siteAppealResolution: {
    oneTimeTokenLinks: false,
    userId: 8,
    data: {
      to: 'appellant@example.test',
      username: 'eve',
      category: 'Account',
      approved: true,
      restored: true,
      appealUrl: 'https://civitai.com/appeal',
    },
    links: [['https://civitai.com/appeal', 1], [TOS, 2], ...shell(3)],
  },
};

function shell(from: number): [string, number | null][] {
  let n = from;
  return SHELL_LINKS.map((l) => [l, l.startsWith('https://civitai.com/') ? n++ : null]);
}

const tracked = (n: number) => `https://civitai.com/api/email/click?p=${n}&s=sig`;
const hrefsOf = (html: string) =>
  [...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gi)].map((m) => m[1]!);

afterEach(() => setEmailLinkTracker(null));

describe('the moderator email template ledger', () => {
  it('lists every template this app renders', () => {
    expect([...byKey.keys()].sort()).toEqual(Object.keys(LEDGER).sort());
  });

  for (const [key, entry] of Object.entries(LEDGER)) {
    it(`${key}: its civitai.com links come back tracked, in order, and the rest as written`, async () => {
      const t = byKey.get(key)!;
      expect(t.oneTimeTokenLinks).toBe(entry.oneTimeTokenLinks);
      const calls: { send: EmailLinkSend; hrefs: string[] }[] = [];
      // Answers as the main app's route does: same-site links signed, numbered among themselves.
      setEmailLinkTracker(async (send, hrefs) => {
        calls.push({ send, hrefs });
        let n = 0;
        return hrefs.map((h) => (h.startsWith('https://civitai.com/') ? tracked(++n) : h));
      });

      const html = await t.getTrackedHtml(entry.data, SEND_ID, { userId: entry.userId });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.send).toEqual({
        sendId: SEND_ID,
        template: key,
        mailClass: 'transactional',
        campaign: '',
        variant: '',
        userId: entry.userId,
      });
      // Every web link the email carries, and nothing else, in document order.
      expect(calls[0]!.hrefs).toEqual(entry.links.map(([l]) => l));
      expect(hrefsOf(html)).toEqual(
        entry.links.map(([l, p]) => (p === null ? l : tracked(p).replace(/&/g, '&amp;')))
      );
    });
  }
});
