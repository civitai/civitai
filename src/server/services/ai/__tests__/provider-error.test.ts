import { describe, expect, it, vi } from 'vitest';
import { ChatError, ConnectionError, RequestTimeoutError } from '@openrouter/sdk/models/errors';
import {
  APP_ERROR_MESSAGES,
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
  it('logs the status, provider and error codes, and no prose', () => {
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 502,
        metadata: {
          provider_name: 'ExampleProvider',
          raw: JSON.stringify({
            error: { code: 'model_overloaded', type: 'server_error', message: 'busy' },
          }),
        },
      },
    });
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).toContain('http=502');
    expect(text).toContain('code=502');
    expect(text).toContain('provider=ExampleProvider');
    expect(text).toContain('upstream_code=model_overloaded');
    expect(text).toContain('upstream_type=server_error');
    expect(text).not.toContain('Provider returned error');
    expect(text).not.toContain('busy');
  });

  // Only short single-token values are kept, so a code field holding a sentence is dropped too.
  it('drops a code field that holds prose', () => {
    const body = JSON.stringify({ error: { code: 'invalid prompt PROMPT_TAIL', type: 'x' } });
    expect(describeProviderError(chatErrorFrom(body))).not.toContain('PROMPT_TAIL');
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
  });

  it('drops everything from the first echoed field of a body that will not parse', () => {
    const cutOff = '{"error":{"message":"bad request","input":"a \\"quoted\\" PROMPT_TAIL and more';
    const text = describeProviderError(chatErrorFrom(cutOff));
    expect(text).not.toContain('PROMPT_TAIL');
  });

  // Python servers echo in their own formats, and a body can arrive double-encoded or with
  // unicode-escaped keys; none of these may carry the prompt into the log.
  it.each([
    ['a Python repr', "{'input': 'PROMPT_TAIL', 'loc': ['body']}"],
    ['text that forges the redaction marker', "{'input': '[redacted] PROMPT_TAIL'}"],
    [
      "OpenRouter's moderation error",
      JSON.stringify({
        error: {
          code: 403,
          message: 'Your input was flagged',
          metadata: { reasons: ['x'], flagged_input: 'PROMPT_TAIL', provider_name: 'OpenAI' },
        },
      }),
    ],
    ['a field name no list would hold', JSON.stringify({ error: { query: 'PROMPT_TAIL' } })],
    [
      'a request echoed with a message field per turn',
      JSON.stringify({ request: { messages: [{ message: 'PROMPT_TAIL' }] } }),
    ],
    [
      'a quoted key inside a kept message',
      JSON.stringify({ error: { message: 'Invalid "input": PROMPT_TAIL' } }),
    ],
    [
      'encoded quotes the echoed text wrote itself',
      JSON.stringify({ error: { message: 'Blocked term "x%22 PROMPT_TAIL %22y"' } }),
    ],
    ['a percent-encoded form body', 'bad body: messages%5B0%5D%5Bcontent%5D=PROMPT_TAIL'],
    ['a backticked serde value', 'messages[0]: unknown variant `PROMPT_TAIL`, expected `user`'],
    ['a Python repr under an unlisted name', "{'error': 'bad', 'query': 'PROMPT_TAIL'}"],
    [
      'a quoted value in a Google message',
      JSON.stringify({
        error: {
          message: 'Provider returned error',
          metadata: {
            raw: JSON.stringify({
              error: {
                code: 400,
                message:
                  'Invalid value at \'contents[0].parts[0].text\' (TYPE_STRING), "PROMPT_TAIL"',
              },
            }),
          },
        },
      }),
    ],
    ['a system_prompt field', '{"error":"x","system_prompt":"PROMPT_TAIL'],
    ['a camelCase systemInstruction field', JSON.stringify({ systemInstruction: 'PROMPT_TAIL' })],
    ['an instructions field', "{'instructions': 'PROMPT_TAIL'}"],
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

  it.each([
    ['backslashes', '\\'],
    ['repeated field names', 'input'],
    ['quotes', '"\\'],
  ])('describes a long run of %s within the cap', (_label, unit) => {
    const text = describeProviderError(chatErrorFrom(`{"error":"${unit.repeat(200_000)}`));
    expect(text.length).toBeLessThanOrEqual(PROVIDER_ERROR_LOG_LIMIT);
  });

  it('describes a body nested past any sane depth without throwing', () => {
    const body = `${'['.repeat(50_000)}"PROMPT_TAIL"${']'.repeat(50_000)}`;
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).not.toContain('PROMPT_TAIL');
    expect(text.length).toBeLessThanOrEqual(PROVIDER_ERROR_LOG_LIMIT);
  });

  // The SDK's fallback error carries the whole raw body inside its message, as free text.
  it("reads the body, not the SDK message's copy of it", () => {
    const body = JSON.stringify({
      error: { message: 'bad', metadata: { raw: JSON.stringify({ detail: 'PROMPT_TAIL' }) } },
    });
    const error = Object.assign(new Error(`API error occurred: Status 403\nBody: ${body}`), {
      body,
    });
    expect(describeProviderError(error)).not.toContain('PROMPT_TAIL');
  });

  // A provider name is the one kept field that may hold spaces.
  it('replaces a line that repeats text the request carried', () => {
    const prompt = 'lighthouse at dusk in impasto';
    const body = JSON.stringify({
      error: { code: 400, metadata: { provider_name: prompt.toUpperCase() } },
    });
    expect(describeProviderError(chatErrorFrom(body), { sent: [prompt] })).not.toMatch(/impasto/i);
    // The same line with nothing to compare against shows the comparison is what removed it.
    expect(describeProviderError(chatErrorFrom(body))).toMatch(/impasto/i);
  });

  it('matches a prompt the provider re-encoded', () => {
    const prompt = 'ｌｉｇｈｔ\u200bｈｏｕｓｅ　ａｔ　ｄｕｓｋ';
    const body = JSON.stringify({ error: { metadata: { provider_name: 'lighthouse at dusk' } } });
    expect(describeProviderError(chatErrorFrom(body), { sent: [prompt] })).not.toMatch(
      /lighthouse/
    );
  });

  it('caps the result at about 1 KB', () => {
    const text = describeProviderError(chatErrorFrom(`${providerBody} ${'word '.repeat(2000)}`));
    expect(text.length).toBeLessThanOrEqual(PROVIDER_ERROR_LOG_LIMIT);
  });

  it('describes an error with no message or body by its fields', () => {
    expect(describeProviderError({ code: 'ETIMEDOUT' })).toContain('ETIMEDOUT');
  });

  it('describes a plain Error by its class, not its message', () => {
    const text = describeProviderError(new Error('No content in response'));
    expect(text).toContain('error=Error');
    expect(text).not.toContain('No content');
  });

  it('never throws, even when reading the error does', () => {
    const error = {
      get name(): string {
        throw new Error('boom');
      },
    };
    expect(describeProviderError(error)).toBe('unreadable provider error');
  });

  it("tags the app's own error messages, and nothing that merely starts like one", () => {
    expect(describeProviderError(new Error(APP_ERROR_MESSAGES.json_parse))).toContain(
      'reason=json_parse'
    );
    const echoed = describeProviderError(
      new Error(`${APP_ERROR_MESSAGES.no_content}: PROMPT_TAIL`)
    );
    expect(echoed).not.toContain('reason=');
    expect(echoed).not.toContain('PROMPT_TAIL');
  });

  it('logs the socket code a connection failure wraps', () => {
    const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const error = new ConnectionError('Unable to make request', {
      cause: new TypeError('fetch failed', { cause: socket }),
    });
    expect(describeProviderError(error)).toContain('cause=ECONNRESET');
  });

  it('logs what kind of timeout ended the request', () => {
    const error = new RequestTimeoutError('Request timed out', {
      cause: new DOMException('The operation timed out.', 'TimeoutError'),
    });
    const text = describeProviderError(error);
    expect(text).toContain('error=RequestTimeoutError');
    expect(text).toContain('cause=TimeoutError');
  });

  it('keeps the numeric fields of a line it redacts for echoing the request', () => {
    const prompt = 'lighthouse at dusk in impasto';
    const body = JSON.stringify({ error: { code: 400, metadata: { provider_name: prompt } } });
    const text = describeProviderError(chatErrorFrom(body), { sent: [prompt] });
    expect(text).toContain('redacted');
    expect(text).toContain('http=502');
    expect(text).toContain('code=400');
    expect(text).not.toMatch(/impasto/i);
  });

  it.each([
    ['provider_name', 'Basic dXNlcjpwYXNz'],
    ['provider_name', 'bearer abcdef123456'],
    ['provider_name', 'https://cdn.example/a/b.jpg'],
    ['model_slug', 'https://cdn.example/a/b.jpg'],
  ])('drops a credential or URL in %s', (field, value) => {
    const body = JSON.stringify({ error: { code: 400, metadata: { [field]: value } } });
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).toContain('code=400');
    expect(text).not.toContain(value);
  });

  it('keeps provider names and model slugs that look like neither', () => {
    const body = JSON.stringify({
      error: { metadata: { provider_name: 'Google AI Studio', model_slug: 'openai/gpt-4.1:free' } },
    });
    const text = describeProviderError(chatErrorFrom(body));
    expect(text).toContain('provider=Google AI Studio');
    expect(text).toContain('model=openai/gpt-4.1:free');
  });

  it('bounds the echo check by the scan limit, however long the sent text', () => {
    const body = JSON.stringify({ error: { code: 400, metadata: { provider_name: 'Example' } } });
    const has = vi.spyOn(Set.prototype, 'has');
    const includes = vi.spyOn(String.prototype, 'includes');
    try {
      describeProviderError(chatErrorFrom(body), { sent: ['abcdefghijklmnopq'.repeat(120_000)] });
      expect(has.mock.calls.length + includes.mock.calls.length).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      has.mockRestore();
      includes.mockRestore();
    }
  });
});
