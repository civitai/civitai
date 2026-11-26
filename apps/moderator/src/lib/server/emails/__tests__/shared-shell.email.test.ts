import { beforeEach, describe, expect, it, vi } from 'vitest';

// Both appeal emails render inside the shared @civitai/email layout (the main app's shell), and still
// carry their subject, links and copy. The send is captured at the package's client module, so no
// transport is built and nothing leaves the process.
type Sent = { subject: string; to: unknown; html: string; text?: string };
const sent = vi.hoisted(() => [] as Sent[]);
vi.mock('@civitai/email/src/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendEmail: async (input: Sent) => {
    sent.push(input);
  },
}));

const { appealResolutionEmail, siteAppealResolutionEmail } = await import(
  '../appeal-resolution.email'
);

// Markers only the shared shell emits: the dark brand band cell and the logo it carries.
const BAND = '<td class="em-band" align="left" bgcolor="#1A1B1E"';
const LOGO =
  '<img src="https://civitai.com/images/email/logo-dark-band@2x.png" width="142" height="30" alt="Civitai"';
const TOS = '<a href="https://civitai.com/content/tos">Terms of Service</a>';

const only = () => {
  expect(sent).toHaveLength(1);
  return sent[0];
};

beforeEach(() => {
  sent.length = 0;
});

describe('appealResolutionEmail', () => {
  it('renders an approval inside the shared shell with its subject, items and terms link', async () => {
    await appealResolutionEmail.send({
      to: 'appellant@example.test',
      username: 'eve',
      approved: true,
      items: [{ url: 'https://example.test/images/7', label: 'Image #7' }, { label: 'Image #8' }],
    });
    const msg = only();
    expect(msg.subject).toBe('Civitai - Appeal approved');
    expect(msg.to).toBe('appellant@example.test');
    expect(msg.html).toContain(BAND);
    expect(msg.html).toContain(LOGO);
    expect(msg.html).toMatch(/<h1 class="em-h1"[^>]*>Appeal Approved<\/h1>/);
    expect(msg.html).toContain('Hi eve,');
    expect(msg.html).toContain('<li><a href="https://example.test/images/7">Image #7</a></li>');
    expect(msg.html).toContain('<li>Image #8</li>');
    expect(msg.html).toContain(TOS);
    expect(msg.text).toContain('- Image #7 (https://example.test/images/7)');
  });

  it('keeps the rejection subject and heading', async () => {
    await appealResolutionEmail.send({
      to: 'a@example.test',
      username: 'eve',
      approved: false,
      items: [],
    });
    const msg = only();
    expect(msg.subject).toBe('Civitai - Appeal decision');
    expect(msg.html).toContain(BAND);
    expect(msg.html).toMatch(/<h1 class="em-h1"[^>]*>Appeal Decision<\/h1>/);
    expect(msg.html).not.toContain('Affected content:');
  });
});

describe('siteAppealResolutionEmail', () => {
  it('renders inside the shared shell with its subject, decision text and appeal link', async () => {
    await siteAppealResolutionEmail.send({
      to: 'appellant@example.test',
      username: 'eve',
      category: 'Model',
      approved: true,
      restored: true,
      appealUrl: 'https://example.test/appeal',
    });
    const msg = only();
    expect(msg.subject).toBe('Civitai - Appeal approved');
    expect(msg.html).toContain(BAND);
    expect(msg.html).toContain(LOGO);
    expect(msg.html).toMatch(/<h1 class="em-h1"[^>]*>Appeal Approved<\/h1>/);
    expect(msg.html).toContain('We reviewed your appeal and republished your model.');
    expect(msg.html).toContain('<a href="https://example.test/appeal">See the decision</a>');
    expect(msg.html).toContain(TOS);
    expect(msg.text).toContain('See the decision: https://example.test/appeal');
  });
});
