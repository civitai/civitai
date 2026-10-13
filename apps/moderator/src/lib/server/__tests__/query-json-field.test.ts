import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { jsonField, parseForm } = await import('../query');

const form = (value: string) => {
  const data = new FormData();
  data.append('v', value);
  return data;
};
const schema = z.object({
  v: jsonField(z.array(z.number(), { error: 'Not a list.' }), 'Bad JSON.'),
});

describe('jsonField', () => {
  it('parses and validates the JSON', () => {
    expect(parseForm(schema, form('[1,2]'))).toEqual({ v: [1, 2] });
  });

  it('fails malformed JSON with its message, and a schema mismatch with the schema’s', () => {
    expect(parseForm(schema, form('[1,'))).toBe('Bad JSON.');
    expect(parseForm(schema, form('{"a":1}'))).toBe('Not a list.');
  });
});
