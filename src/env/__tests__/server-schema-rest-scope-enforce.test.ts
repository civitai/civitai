import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverSchema } from '~/env/server-schema';

const field = serverSchema.shape.REST_SCOPE_ENFORCE;

describe('REST_SCOPE_ENFORCE', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());

  it.each(['off', 'report', 'enforce'] as const)('reads %j as itself, quietly', (value) => {
    expect(field.parse(value)).toBe(value);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('reads %j as off, quietly', (value) => {
    expect(field.parse(value)).toBe('off');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['enforced', 'ENFORCE', 'on'])('reads %j as off and warns once, naming it', (value) => {
    expect(field.parse(value)).toBe('off');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(JSON.stringify(value));
  });
});
