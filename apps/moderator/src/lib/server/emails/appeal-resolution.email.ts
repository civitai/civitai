import { createEmail, renderEmailShell } from '@civitai/email';
import { escapeHtml } from '@civitai/shared/html-escape';
import { env } from '$env/dynamic/private';
import { siteAppealDecisionText, type SiteAppealCategory } from '@civitai/shared/site-appeal';

export type AppealResolutionEmailData = {
  to: string;
  username: string;
  approved: boolean;
  // Affected content, each linked when a public URL is available.
  items: { url?: string; label: string }[];
};

const tosFooter =
  'For more information, see our <a href="https://civitai.com/content/tos">Terms of Service</a>.';

// Appeal-resolution email — the spoke's own copy of the two appeal kinds from the main app's
// moderationAction email (per the @civitai/email convention, branded copy lives in each app; the package
// owns the SMTP transport and the shared layout, renderEmailShell). The moderator's free-text
// `resolvedMessage` is intentionally NOT emailed — it's shown only in-app — so the email carries only
// the decision + the affected items.
export const appealResolutionEmail = createEmail<AppealResolutionEmailData, never>({
  header: ({ to, approved }) => ({
    to,
    from: env.EMAIL_FROM,
    subject: approved ? 'Civitai - Appeal approved' : 'Civitai - Appeal decision',
  }),
  html: ({ username, approved, items }) => {
    const heading = approved ? 'Appeal Approved' : 'Appeal Decision';
    const intro = approved
      ? 'We have reviewed your appeal and approved it. Any affected content and your account standing have been restored.'
      : 'We have reviewed your appeal. After careful consideration, the original moderation decision stands.';
    const list = items
      .map(
        (i) =>
          `<li>${
            i.url ? `<a href="${i.url}">${escapeHtml(i.label)}</a>` : escapeHtml(i.label)
          }</li>`
      )
      .join('');
    return renderEmailShell({
      header: heading,
      body: `<p style="margin: 0 0 16px 0;">Hi ${escapeHtml(username)},</p>
        <p style="margin: 0 0 16px 0;">${intro}</p>
        ${
          items.length
            ? `<p style="margin: 0 0 8px 0;">Affected content:</p><ul style="margin: 0; padding-left: 24px;">${list}</ul>`
            : ''
        }`,
      footer: tosFooter,
    });
  },
  text: ({ username, approved, items }) => {
    const intro = approved
      ? 'We have reviewed your appeal and approved it. Any affected content and your account standing have been restored.'
      : 'We have reviewed your appeal. After careful consideration, the original moderation decision stands.';
    const lines = items.map((i) => `- ${i.label}${i.url ? ` (${i.url})` : ''}`).join('\n');
    return `Hi ${username},\n\n${intro}\n\n${
      items.length ? `Affected content:\n${lines}\n\n` : ''
    }Terms of Service: https://civitai.com/content/tos`;
  },
});

export type SiteAppealResolutionEmailData = {
  to: string;
  username: string;
  category: SiteAppealCategory;
  approved: boolean;
  restored: boolean;
  /** Where the appellant reads the decision, including the moderator's message. */
  appealUrl: string;
};

// The site appeal form's decision. Same rule as above: the moderator's message stays out of the email;
// the appeal page shows it, and that page is reachable from the banned screen.
export const siteAppealResolutionEmail = createEmail<SiteAppealResolutionEmailData, never>({
  header: ({ to, approved }) => ({
    to,
    from: env.EMAIL_FROM,
    subject: approved ? 'Civitai - Appeal approved' : 'Civitai - Appeal decision',
  }),
  html: ({ username, category, approved, restored, appealUrl }) => {
    const heading = approved ? 'Appeal Approved' : 'Appeal Decision';
    const text = siteAppealDecisionText({ category, approved, restored });
    return renderEmailShell({
      header: heading,
      body: `<p style="margin: 0 0 16px 0;">Hi ${escapeHtml(username)},</p>
        <p style="margin: 0 0 16px 0;">${escapeHtml(text)}</p>
        <p style="margin: 0;"><a href="${escapeHtml(appealUrl)}">See the decision</a></p>`,
      footer: tosFooter,
    });
  },
  text: ({ username, category, approved, restored, appealUrl }) =>
    `Hi ${username},\n\n${siteAppealDecisionText({
      category,
      approved,
      restored,
    })}\n\nSee the decision: ${appealUrl}\n\nTerms of Service: https://civitai.com/content/tos`,
});
