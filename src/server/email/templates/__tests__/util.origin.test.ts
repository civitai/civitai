import { describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';

// The shell in @civitai/email defaults the logo origin to https://civitai.com, which is also the
// origin util.shell.test.ts uses, so that snapshot cannot see the main app's override go missing.
// A non-default origin here can: the logo must follow the main app's own base URL.
setEnv({ NEXTAUTH_URL: 'https://staging.example.test' });

const { simpleEmailWithTemplate } = await import('~/server/email/templates/util');

describe('simpleEmailWithTemplate logo origin', () => {
  it("loads the logo from the main app's own origin, not the package default", () => {
    const html = simpleEmailWithTemplate({ header: 'Heading', body: '<p>Body</p>' });
    expect(html).toContain(
      '<img src="https://staging.example.test/images/email/logo-dark-band@2x.png"'
    );
    expect(html).not.toContain('https://civitai.com/images/email/');
  });
});
