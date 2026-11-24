import { readdirSync } from 'fs';
import { decode } from 'he';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';

// A production-shaped origin, so the logo's https URL is checked as it ships, not as
// http://localhost. getBaseUrl reads NEXTAUTH_URL when it is called; setEnv is per-file.
setEnv({ NEXTAUTH_URL: 'https://civitai.com' });
const ORIGIN = 'https://civitai.com';

type Template = {
  template?: unknown;
  mailClass?: unknown;
  optOutType?: unknown;
  oneTimeTokenLinks?: unknown;
  getHtml: (data: unknown) => string;
  getText: (data: unknown) => string;
  render: (
    data: unknown,
    input: { sendId: string; userId?: number; campaign?: string; variant?: string }
  ) => { html: string; text: string; headers: Record<string, string> };
  getTestData?: (input: Record<string, unknown>) => Promise<unknown>;
};
const isTemplate = (value: unknown): value is Template =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Template).getHtml === 'function' &&
  typeof (value as Template).getText === 'function';

// Every *.email.ts file under templates/, so a template that is never added to index.ts is still
// covered. Imported at module scope so the transform is not charged to one test's timeout.
const TEMPLATES_DIR = path.resolve(__dirname, '..');
const files = readdirSync(TEMPLATES_DIR, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.email.ts') && f !== 'base.email.ts')
  .sort();
const modules = await Promise.all(
  files.map(async (f) => [f, await import(path.join(TEMPLATES_DIR, f))] as const)
);
const indexModule: Record<string, unknown> = await import('~/server/email/templates');

const fromFiles = new Map<string, Template>();
for (const [, mod] of modules)
  for (const [name, value] of Object.entries(mod))
    if (isTemplate(value)) fromFiles.set(name, value);
const indexNames = Object.entries(indexModule)
  .filter(([, value]) => isTemplate(value))
  .map(([name]) => name)
  .sort();

/**
 * Not a branded email: Legal's intake reads its key=value lines by machine, so it is a bare
 * <pre> on purpose and never gets the shared document.
 */
const UNBRANDED = ['personalDataExportRefusedEmail'];

const testData = new Map(
  await Promise.all(
    [...fromFiles.entries()].map(async ([name, template]) => {
      const data = await template.getTestData?.({});
      if (!data) throw new Error(`${name} has no testData`);
      return [name, data] as const;
    })
  )
);

const rendered = [...fromFiles.entries()]
  .filter(([name]) => !UNBRANDED.includes(name))
  .sort()
  .map(([name, template]) => {
    const data = testData.get(name);
    return { name, html: template.getHtml(data), text: template.getText(data) };
  });

/** The app-review emails, rendered through the notification email as they are sent. */
const APP_REVIEW_TYPES = ['app-block-approved', 'app-block-rejected'];

const openingTags = (html: string, tag: string) =>
  html.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) ?? [];

describe('every email template renders the shared document', () => {
  it('finds every template, in index.ts and on disk', () => {
    // Pinned so a discovery that silently matches fewer files fails here instead of passing the loop.
    expect(fromFiles.size).toBe(29);
    expect(indexNames).toHaveLength(21);
    for (const name of indexNames) expect(fromFiles.has(name), name).toBe(true);
    expect(rendered.map((r) => r.name)).toContain('notificationEmail');
    // Each exemption names a real template, and only it is skipped.
    for (const name of UNBRANDED) expect(fromFiles.has(name), name).toBe(true);
    expect(rendered).toHaveLength(fromFiles.size - UNBRANDED.length);
  });

  it.each(rendered.map((r) => [r.name, r] as const))('%s', (_name, { html, text }) => {
    expect(
      html.startsWith(
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'
      )
    ).toBe(true);
    expect(html).toMatch(/<html lang="en" dir="ltr"/);
    expect(html).toContain('<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />');
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(openingTags(html, 'h1')).toHaveLength(1);

    // Layout tables are role="presentation". A table without it must be a data table: it has
    // header cells before it closes.
    const tables = openingTags(html, 'table');
    expect(tables.length).toBeGreaterThanOrEqual(3);
    let index = 0;
    for (const tag of tables) {
      index = html.indexOf(tag, index);
      if (!/role="presentation"/.test(tag)) {
        const end = html.indexOf('</table>', index);
        expect(html.slice(index, end), `data table without <th>: ${tag}`).toMatch(/<th[\s>]/);
      }
      index += tag.length;
    }
    expect(tables.filter((tag) => /role="presentation"/.test(tag)).length).toBeGreaterThanOrEqual(
      3
    );

    // The logo: 2x PNG shown at 1x, absolute https URL, alt text, on the dark band.
    const logo = openingTags(html, 'img').find((tag) => tag.includes('logo-dark-band'));
    expect(logo).toBeDefined();
    expect(logo).toContain(`src="${ORIGIN}/images/email/logo-dark-band@2x.png"`);
    expect(logo).toContain('alt="Civitai"');
    expect(logo).toContain('width="142"');
    expect(logo).toContain('height="30"');
    expect(logo).toMatch(/display: block; border: 0;/);
    const band = openingTags(html, 'td').find((tag) => tag.includes('em-band'));
    expect(band).toContain('bgcolor="#1A1B1E"');
    expect(band).toContain('background-color: #1A1B1E');
    expect(band).toContain('background-image: linear-gradient(#1A1B1E, #1A1B1E)');

    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(102 * 1024);

    // A button's link reaches the plain-text part.
    const button = html.match(/<a class="em-btn" href="([^"]+)"/);
    if (button) expect(text).toContain(decode(button[1]!));
    expect(text).not.toMatch(/<[a-z][^>]*>/i);
  });

  it('a button is present on the emails that had one, so the plain-text check above runs', () => {
    const withButton = rendered.filter((r) => /<a class="em-btn" href=/.test(r.html));
    expect(withButton.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'emailVerificationEmail',
        'missedNotificationsDigestEmail',
        'notificationEmail',
        'strikeIssuedEmail',
        'trainingCompleteEmail',
        'trainingFailEmail',
      ])
    );
  });
});

describe('app-review emails', () => {
  it.each(APP_REVIEW_TYPES)('%s never says "app block"', async (type) => {
    const { notificationProcessors, getNotificationMessage } = await import(
      '~/server/notifications/utils.notifications'
    );
    const { notificationEmail } = await import('~/server/email/templates/notification.email');
    const prepared = getNotificationMessage({
      type,
      details: {
        slug: 'pixel-pal',
        name: 'Pixel Pal',
        reason: 'Broken build',
        hasPage: true,
        canOpenRunPage: true,
      },
    });
    expect(prepared?.message).toBeTruthy();
    const data = {
      to: 'dev@example.com',
      typeName: notificationProcessors[type]!.displayName,
      message: prepared!.message,
      url: prepared!.url,
      btnLabel: prepared!.emailButtonLabel,
      unsubscribeUrl: `${ORIGIN}/api/notifications/email-unsubscribe?u=1&t=${type}&s=x`,
    };
    const html = notificationEmail.getHtml(data);
    const text = notificationEmail.getText(data);
    expect(html).toContain('Pixel Pal');
    // The unsubscribe link carries the stored type key (`t=app-block-…`) by design, so URLs are
    // removed first: what is checked is the copy a reader sees.
    const visibleHtml = html.replace(/\shref="[^"]*"/g, '');
    const visibleText = text.replace(/https?:\/\/\S+/g, '');
    expect(html).toMatch(/app[\s-]?block/i); // positive control: the same pattern sees the key
    expect(visibleHtml).not.toMatch(/app[\s-]?block/i);
    expect(visibleText).not.toMatch(/app[\s-]?block/i);
    expect(visibleHtml).toContain(`<title>${data.typeName}</title>`);
  });
});

/**
 * Every template's send-row tags (emailEvents.template, emailEvents.mailClass), pinned whole: a
 * template added without them, or with a key or class changed, fails here. Only the weekly digest
 * is lifecycle mail; the rest are mail a user needs or asked for. Edit this on purpose.
 */
const TAGS: Record<string, [string, string]> = {
  bankingChangeNoticeEmail: ['bankingChangeNotice', 'transactional'],
  bountyAutomaticallyAwardedEmail: ['bountyAutomaticallyAwarded', 'transactional'],
  bountyExpiredEmail: ['bountyExpired', 'transactional'],
  bountyExpiredReminderEmail: ['bountyExpiredReminder', 'transactional'],
  bountyRefundedEmail: ['bountyRefunded', 'transactional'],
  emailVerificationEmail: ['emailVerification', 'transactional'],
  klein9bNoticeEmail: ['klein9bNotice', 'transactional'],
  membershipGiftReceivedEmail: ['membershipGiftReceived', 'transactional'],
  membershipGiftSentEmail: ['membershipGiftSent', 'transactional'],
  merchBuzzCreditedEmail: ['merchBuzzCredited', 'transactional'],
  merchClaimInviteEmail: ['merchClaimInvite', 'transactional'],
  missedNotificationsDigestEmail: ['missedNotificationsDigest', 'lifecycle'],
  moderationActionEmail: ['moderationAction', 'transactional'],
  ncEarningsNoticeEmail: ['ncEarningsNotice', 'transactional'],
  notificationEmail: ['notification', 'transactional'],
  openCryptoDepositDigestEmail: ['openCryptoDepositDigest', 'transactional'],
  paddleCancellationEmail: ['paddleCancellation', 'transactional'],
  personalDataExportBuiltEmail: ['personalDataExportBuilt', 'transactional'],
  personalDataExportHeldEmail: ['personalDataExportHeld', 'transactional'],
  personalDataExportReadyEmail: ['personalDataExportReady', 'transactional'],
  personalDataExportRefusedEmail: ['personalDataExportRefused', 'transactional'],
  prepaidTokenUnlockedEmail: ['prepaidTokenUnlocked', 'transactional'],
  redeemableCodePurchaseEmail: ['redeemableCodePurchase', 'transactional'],
  strikeIssuedEmail: ['strikeIssued', 'transactional'],
  stuckCryptoDepositDigestEmail: ['stuckCryptoDepositDigest', 'transactional'],
  stuckCryptoDepositUserEmail: ['stuckCryptoDepositUser', 'transactional'],
  tipaltiTaxFormRequiredEmail: ['tipaltiTaxFormRequired', 'transactional'],
  trainingCompleteEmail: ['trainingComplete', 'transactional'],
  trainingFailEmail: ['trainingFail', 'transactional'],
};

describe('every email template tags its sends', () => {
  it('with the pinned template key and mail class', () => {
    const found = Object.fromEntries(
      [...fromFiles.entries()].map(([name, t]) => [name, [t.template, t.mailClass]])
    );
    expect(found).toEqual(TAGS);
  });

  it('with a key no other template uses', () => {
    const keys = Object.values(TAGS).map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * Tracked links. Every link a template sends is the tracked click redirect, except:
 *   - every link of a template whose links carry a single-use token (TOKEN_LINK_TEMPLATES, pinned
 *     whole: sign-in, verification, password reset, invite and claim links stay direct and
 *     uncounted, so a scanner following a redirect never spends one);
 *   - a link off the site, or not http(s): the redirect only goes to a site path;
 *   - a link to one of our own signed endpoints (OWN_SIGNED_PATHS).
 * Same-site and off-site are decided here from the test's own origin, not by the rewriter's code.
 */
const TOKEN_LINK_TEMPLATES = ['emailVerificationEmail', 'merchClaimInviteEmail'];
const OWN_SIGNED_PATHS = [
  '/api/email/click',
  '/api/notifications/digest-click',
  '/api/notifications/email-unsubscribe',
];
const SEND = {
  sendId: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  userId: 77,
  campaign: 'camp-1',
  variant: 'arm-b',
};
const hrefs = (html: string) =>
  [...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gi)].map((m) => decode(m[1]!));
const isSameSite = (href: string) => {
  try {
    const url = new URL(href, ORIGIN);
    return url.origin === ORIGIN && (url.protocol === 'https:' || url.protocol === 'http:');
  } catch {
    return false;
  }
};
const ownSigned = (href: string) => OWN_SIGNED_PATHS.includes(new URL(href, ORIGIN).pathname);
const sitePath = (href: string) => {
  const url = new URL(href, ORIGIN);
  return `${url.pathname}${url.search}${url.hash}`;
};

const { verifyEmailClick, NEVER_WRAPPED_PATHS, EMAIL_CLICK_PATH } = await import(
  '~/server/email/link-tracking'
);
const { DIGEST_CLICK_PATH } = await import('~/server/notifications/digest-tracking');
const { LIFECYCLE_EMAIL_OPT_OUTS } = await import('~/server/email/lifecycle-opt-outs');
const { isEmailOptOutType } = await import('~/server/notifications/utils.notifications');

const sends = [...fromFiles.entries()].sort().map(([name, template]) => {
  const data = testData.get(name);
  return { name, template, plain: template.getHtml(data), sent: template.render(data, SEND) };
});

describe('every email template tracks its links', () => {
  it('the templates whose links carry a single-use token are exactly these', () => {
    const declared = sends.filter((s) => s.template.oneTimeTokenLinks === true).map((s) => s.name);
    expect(declared).toEqual(TOKEN_LINK_TEMPLATES);
  });

  it('the paths never wrapped are the click, digest-click and unsubscribe routes', () => {
    expect([...NEVER_WRAPPED_PATHS].sort()).toEqual([...OWN_SIGNED_PATHS].sort());
    expect(NEVER_WRAPPED_PATHS).toContain(EMAIL_CLICK_PATH);
    expect(NEVER_WRAPPED_PATHS).toContain(DIGEST_CLICK_PATH);
  });

  it('every <a> has a double-quoted href, the only form the rewriter reads', () => {
    for (const { name, sent, plain } of sends)
      for (const html of [sent.html, plain]) {
        const anchors = html.match(/<a\b[^>]*>/gi) ?? [];
        for (const tag of anchors) expect(tag, name).toMatch(/\shref="/);
      }
  });

  it.each(TOKEN_LINK_TEMPLATES)('%s sends every link as it is, untracked', (name) => {
    const send = sends.find((s) => s.name === name)!;
    expect(send.sent.html).toBe(send.plain);
    expect(hrefs(send.sent.html).length).toBeGreaterThan(0);
    expect(send.sent.html).not.toContain(EMAIL_CLICK_PATH);
  });

  it.each(sends.filter((s) => !TOKEN_LINK_TEMPLATES.includes(s.name)).map((s) => [s.name, s]))(
    '%s sends each same-site link through the signed click redirect, in order',
    (_name, { template, plain, sent }) => {
      const before = hrefs(plain);
      const after = hrefs(sent.html);
      expect(after).toHaveLength(before.length);
      let position = 0;
      before.forEach((href, i) => {
        if (!isSameSite(href) || ownSigned(href)) {
          expect(after[i]).toBe(href);
          return;
        }
        position++;
        const url = new URL(after[i]!);
        expect(url.origin).toBe(ORIGIN);
        expect(url.pathname).toBe('/api/email/click');
        expect(verifyEmailClick(Object.fromEntries(url.searchParams))).toEqual({
          ...SEND,
          template: template.template,
          mailClass: template.mailClass,
          position,
          to: sitePath(href),
        });
      });
    }
  );

  it('positive controls: the notification button is tracked, the verification button is not', () => {
    const notification = sends.find((s) => s.name === 'notificationEmail')!;
    const button = notification.sent.html.match(/<a class="em-btn" href="([^"]+)"/)![1]!;
    const click = verifyEmailClick(Object.fromEntries(new URL(decode(button)).searchParams));
    expect(click).toMatchObject({ template: 'notification', userId: 77, sendId: SEND.sendId });
    const verification = sends.find((s) => s.name === 'emailVerificationEmail')!;
    expect(verification.sent.html).toContain(
      'class="em-btn" href="https://civitai.com/verify-email?token=test-token"'
    );
    // Across all templates, the redirect is actually used.
    const tracked = sends
      .flatMap((s) => hrefs(s.sent.html))
      .filter((h) => h.includes('/api/email/click?'));
    expect(tracked.length).toBeGreaterThan(sends.length);
  });
});

describe('every lifecycle email carries its own opt-out', () => {
  it('each lifecycle template declares an opt-out type, listed for it; no other template has one', () => {
    const lifecycle = Object.fromEntries(
      sends
        .filter((s) => s.template.mailClass === 'lifecycle')
        .map((s) => [s.template.optOutType, s.template.template])
    );
    expect(lifecycle).toEqual(LIFECYCLE_EMAIL_OPT_OUTS);
    expect(lifecycle).toEqual({ 'missed-notification-digest': 'missedNotificationsDigest' });
    for (const type of Object.keys(lifecycle)) expect(isEmailOptOutType(type), type).toBe(true);
    for (const s of sends.filter((s) => s.template.mailClass !== 'lifecycle'))
      expect(s.template.optOutType, s.name).toBeUndefined();
  });

  it.each(sends.filter((s) => s.template.mailClass === 'lifecycle').map((s) => [s.name, s]))(
    '%s: List-Unsubscribe one-click with the send id, and the footer links',
    (_name, { template, sent }) => {
      expect(sent.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      const header = sent.headers['List-Unsubscribe']!;
      expect(header).toMatch(
        /^<https:\/\/civitai\.com\/api\/notifications\/email-unsubscribe\?.+>$/
      );
      const unsubscribe = new URL(header.slice(1, -1));
      expect(unsubscribe.searchParams.get('t')).toBe(template.optOutType);
      expect(unsubscribe.searchParams.get('e')).toBe(SEND.sendId);
      const links = hrefs(sent.html);
      // The opt-out link in the body is the header's own, untracked.
      expect(links).toContain(unsubscribe.toString());
      expect(sent.text).toContain(unsubscribe.toString());
      // The email settings link, tracked like any other site link.
      const settings = links
        .filter((h) => h.includes('/api/email/click?'))
        .map((h) => verifyEmailClick(Object.fromEntries(new URL(h).searchParams))?.to);
      expect(settings).toContain('/user/account#notification-settings');
    }
  );
});
