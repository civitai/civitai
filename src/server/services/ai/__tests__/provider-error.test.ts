import { ChatError } from '@openrouter/sdk/models/errors';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ERROR_LOG_LIMIT,
  describeProviderError,
} from '~/server/services/ai/provider-error';

// A genuine SDK error, so the fixture cannot drift from where the SDK puts the body.
function chatErrorFrom(rawBody: string) {
  return new ChatError(
    {
      error: { message: 'Provider returned error', code: 502 },
      request$: new Request('https://openrouter.ai/api/v1/chat/completions'),
      response$: new Response(rawBody, { status: 502 }),
      body$: rawBody,
    } as never,
    {
      request: new Request('https://openrouter.ai/api/v1/chat/completions'),
      response: new Response(rawBody, { status: 502 }),
      body: rawBody,
    }
  );
}

const providerBody = JSON.stringify({
  error: {
    message: 'Provider returned error',
    code: 502,
    metadata: {
      raw: 'upstream: no healthy endpoint for model; fetch of https://image.example/abc/width=512/image.jpeg?sig=xyz failed',
      provider_name: 'ExampleProvider',
    },
  },
});

describe('describeProviderError', () => {
  it("surfaces the provider's own reason, not just the SDK's generic message", () => {
    const text = describeProviderError(chatErrorFrom(providerBody));
    expect(text).toContain('Provider returned error');
    expect(text).toContain('no healthy endpoint for model');
    expect(text).toContain('ExampleProvider');
  });

  it('strips image URLs and credential-looking strings', () => {
    const body = `${providerBody} Authorization: Bearer abc.def.ghi key=sk-or-v1-0123456789abcdef data:image/png;base64,iVBORw0KGgo token=${'a1'.repeat(
      24
    )}`;
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('image.example');
    expect(text).not.toContain('sk-or-v1');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('iVBORw0KGgo');
    expect(text).not.toContain('a1a1a1a1a1a1a1a1');
    expect(text).toContain('no healthy endpoint for model');
  });

  it('drops request fields a provider echoes back, which carry the system prompt', () => {
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        metadata: {
          raw: JSON.stringify({
            detail: [{ loc: ['body', 'messages', 0, 'content'], input: 'SYSTEM PROMPT TEXT' }],
            messages: [{ role: 'system', content: 'SYSTEM PROMPT TEXT' }],
          }),
        },
      },
    });
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).not.toContain('SYSTEM PROMPT TEXT');
    expect(text).toContain('Provider returned error');
  });

  // The echoed text is a user's generation prompt, so it can hold any quote or bracket.
  it.each([
    ['a quote', 'a "quoted" PROMPT_TAIL'],
    ['a closing bracket', 'weights [1.2] PROMPT_TAIL'],
  ])('drops an echoed field whose text contains %s', (_label, prompt) => {
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        metadata: {
          raw: JSON.stringify({
            input: prompt,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          }),
        },
      },
    });
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).not.toContain('PROMPT_TAIL');
    expect(text).toContain('Provider returned error');
  });

  it('drops everything from the first echoed field of a body that will not parse', () => {
    const cutOff = '{"error":{"message":"bad request","input":"a \\"quoted\\" PROMPT_TAIL and more';
    const text = describeProviderError(chatErrorFrom(cutOff));
    expect(text).not.toContain('PROMPT_TAIL');
    expect(text).toContain('bad request');
  });

  // Python servers echo in their own formats, and a body can arrive double-encoded or with
  // unicode-escaped keys; none of these may carry the prompt into the log.
  it.each([
    ['a Python repr', "{'input': 'PROMPT_TAIL', 'loc': ['body']}"],
    [
      'a Python repr inside the envelope',
      JSON.stringify({
        error: {
          message: 'Provider returned error',
          metadata: { raw: "{'content': 'PROMPT_TAIL'}" },
        },
      }),
    ],
    [
      'a pydantic validation message',
      JSON.stringify({
        error: {
          message: 'Provider returned error',
          metadata: {
            raw: JSON.stringify({
              object: 'error',
              message: "1 validation error input_value={'type': 'text', 'text': 'PROMPT_TAIL'}",
            }),
          },
        },
      }),
    ],
    [
      'a cut-off body with a unicode-escaped key',
      '{"error":{"message":"x","\\u0069nput":"PROMPT_TAIL',
    ],
    [
      'a double-encoded envelope',
      JSON.stringify(
        JSON.stringify({
          error: {
            message: 'Provider returned error',
            metadata: { raw: JSON.stringify({ input: 'PROMPT_TAIL' }) },
          },
        })
      ),
    ],
  ])('drops an echo in %s', (_label, body) => {
    expect(describeProviderError(chatErrorFrom(body))).not.toContain('PROMPT_TAIL');
  });

  it('strips JSON-escaped and scheme-relative URLs, Basic auth and Google keys', () => {
    const body = String.raw`{"raw":"fetch https:\/\/image.example\/abc\/x.jpeg?sig=s1 and //cdn.example/x?token=t1 failed; Authorization: Basic dXNlcjpwYXNz key AIzaSyA1b2C3d4E5f6G7h8I9j0"}`;
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).not.toContain('image.example');
    expect(text).not.toContain('cdn.example');
    expect(text).not.toContain('sig=s1');
    expect(text).not.toContain('dXNlcjpwYXNz');
    expect(text).not.toContain('AIzaSy');
    expect(text).toContain('failed');
  });

  it('caps the result at about 1 KB', () => {
    const text = describeProviderError(chatErrorFrom(`${providerBody} ${'word '.repeat(2000)}`));
    expect(text.length).toBeLessThanOrEqual(PROVIDER_ERROR_LOG_LIMIT);
  });

  it('describes an error with no message or body by its fields', () => {
    expect(describeProviderError({ code: 'ETIMEDOUT' })).toContain('ETIMEDOUT');
  });

  it('still describes a plain Error', () => {
    expect(describeProviderError(new Error('No content in response'))).toBe(
      'No content in response'
    );
  });
});
