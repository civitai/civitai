import { createEmail } from '@civitai/email';
import { env } from '$env/dynamic/private';

export type AppealResolutionEmailData = {
  to: string;
  username: string;
  approved: boolean;
  // Affected content, each linked when a public URL is available.
  items: { url?: string; label: string }[];
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Appeal-resolution email — the spoke's own copy of the two appeal kinds from the main app's
// moderationAction email (per the @civitai/email convention, branded copy lives in each app; the package
// owns the SMTP transport). The moderator's free-text `resolvedMessage` is intentionally NOT emailed — it's
// shown only in-app — so the email carries only the decision + the affected items.
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
    return `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
        <h2 style="color: ${approved ? '#12b886' : '#e03131'};">${heading}</h2>
        <p>Hi ${escapeHtml(username)},</p>
        <p>${intro}</p>
        ${items.length ? `<p>Affected content:</p><ul>${list}</ul>` : ''}
        <p style="color: #666; font-size: 13px;">
          For more information, see our
          <a href="https://civitai.com/content/tos">Terms of Service</a>.
        </p>
      </div>`;
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
