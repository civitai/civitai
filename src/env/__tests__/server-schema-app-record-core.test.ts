import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

// The App Storage record core is OFF unless its switch says on, and its key is optional.
describe('APP_RECORD_CORE_ENABLED', () => {
  const field = serverSchema.shape.APP_RECORD_CORE_ENABLED;

  it('is OFF when unset or empty', () => {
    expect(field.parse(undefined)).toBe(false);
    expect(field.parse('')).toBe(false);
  });

  it.each(['false', '0', 'on', 'TRUE'])('stays OFF for %j', (value) => {
    expect(field.parse(value)).toBe(false);
  });

  it('is ON for "true"', () => {
    expect(field.parse('true')).toBe(true);
  });
});

describe('APP_RECORD_OWNER_HANDLE_KEY', () => {
  const field = serverSchema.shape.APP_RECORD_OWNER_HANDLE_KEY;

  it('is optional', () => {
    expect(field.parse(undefined)).toBeUndefined();
  });

  it('keeps a set value as is', () => {
    expect(field.parse('fixture-owner-handle-key-7f3a9c2e5b81d064')).toBe(
      'fixture-owner-handle-key-7f3a9c2e5b81d064'
    );
  });
});
