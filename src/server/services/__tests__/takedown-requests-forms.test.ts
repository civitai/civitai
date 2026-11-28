import { beforeAll, describe, expect, it, vi } from 'vitest';
import { modActionResponse } from '@civitai/moderation';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as TakedownRequests from '~/server/services/takedown-requests.service';

// The moderator app is the network boundary: fetch is the only fake. Stubbed before the module loads,
// because the client keeps the fetch it was built with.
const fetchMock = vi.fn<typeof fetch>();
let getRequestForms: typeof TakedownRequests.getRequestForms;

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  setEnv({
    MOD_CASES_TOKEN: 'cases-token',
    MODERATOR_APP_URL: 'https://mod.example',
    MODERATOR_APP_INTERNAL_URL: '',
  });
  ({ getRequestForms } = await import('~/server/services/takedown-requests.service'));
});

const form = (key: string, mailbox: unknown) => ({
  key,
  title: key,
  mailbox,
  fields: [{ id: 'email', label: 'Email', kind: 'email', required: true }],
});

describe('getRequestForms', () => {
  it('keeps the other forms up when one definition has a bad mailbox', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify(
            modActionResponse({
              definitions: [
                form('dmca-notice', 'dmca@civitai.com'),
                form('likeness-claim', 'not an email'),
              ],
            })
          )
        )
    );
    const forms = await getRequestForms();
    expect(forms.map((f) => f.key)).toEqual(['dmca-notice']);
    expect(forms[0].mailbox).toBe('dmca@civitai.com');
  });
});
