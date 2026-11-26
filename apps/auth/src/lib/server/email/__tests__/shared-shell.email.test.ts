import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each hub email renders inside the shared @civitai/email layout (the main app's shell), and still
// carries its subject, link and copy. The send is captured at the package's client module, so no
// transport is built and nothing leaves the process.
type Sent = { subject: string; to: unknown; html: string; text?: string };
const sent = vi.hoisted(() => [] as Sent[]);
vi.mock('@civitai/email/src/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendEmail: async (input: Sent) => {
    sent.push(input);
  },
}));

const { verificationEmail } = await import('../verification.email');
const { inviteEmail } = await import('../invite.email');

// Markers only the shared shell emits: the dark brand band cell and the logo it carries.
const BAND = '<td class="em-band" align="left" bgcolor="#1A1B1E"';
const LOGO =
  '<img src="https://civitai.com/images/email/logo-dark-band@2x.png" width="142" height="30" alt="Civitai"';

const button = (html: string) => html.match(/<a class="em-btn" href="([^"]*)"[^>]*>([^<]*)<\/a>/);

const only = () => {
  expect(sent).toHaveLength(1);
  return sent[0];
};

beforeEach(() => {
  sent.length = 0;
});

describe('verificationEmail', () => {
  const url = 'https://hub.example.test/login/email/verify?token=tok-verify-123';

  it('renders inside the shared shell with its subject, heading and sign-in link', async () => {
    await verificationEmail.send({ to: 'someone@example.test', url });
    const msg = only();
    expect(msg.subject).toBe('Sign in to Civitai');
    expect(msg.to).toBe('someone@example.test');
    expect(msg.html).toContain(BAND);
    expect(msg.html).toContain(LOGO);
    expect(msg.html).toMatch(/<h1 class="em-h1"[^>]*>Sign in to Civitai<\/h1>/);
    expect(button(msg.html)?.slice(1)).toEqual([url, 'Sign in']);
    expect(msg.html).toContain('This link expires in 24 hours and can be used once.');
    expect(msg.html).toContain("If you didn't request this, you can safely ignore this email.");
    expect(msg.text).toBe(
      `Sign in to Civitai: ${url}\n\nThis link expires in 24 hours and can be used once.`
    );
  });
});

describe('inviteEmail', () => {
  const url = 'https://hub.example.test/invite?token=tok-invite-456';

  it('renders inside the shared shell with its subject, escaped message and accept link', async () => {
    await inviteEmail.send({
      to: 'guest@example.test',
      url,
      appName: 'Pixel Pal',
      invitedBy: 'Ada',
      message: 'Come <b>build</b> with us',
    });
    const msg = only();
    expect(msg.subject).toBe('Ada invited you to Pixel Pal');
    expect(msg.to).toBe('guest@example.test');
    expect(msg.html).toContain(BAND);
    expect(msg.html).toContain(LOGO);
    expect(msg.html).toMatch(/<h1 class="em-h1"[^>]*>Ada invited you to Pixel Pal<\/h1>/);
    expect(msg.html).toContain('Come &lt;b&gt;build&lt;/b&gt; with us');
    expect(msg.html).not.toContain('<b>build</b>');
    expect(button(msg.html)?.slice(1)).toEqual([url, 'Accept invite']);
    expect(msg.html).toContain('This link expires in 7 days and can be used once.');
    expect(msg.text).toContain(`Accept the invite: ${url}`);
  });

  it('keeps the no-inviter headline as subject and heading', async () => {
    await inviteEmail.send({
      to: 'guest@example.test',
      url,
      appName: 'Pixel Pal',
      invitedBy: null,
      message: null,
    });
    const msg = only();
    expect(msg.subject).toBe("You're invited to Pixel Pal");
    expect(msg.html).toMatch(/<h1 class="em-h1"[^>]*>You&#39;re invited to Pixel Pal<\/h1>/);
  });
});
