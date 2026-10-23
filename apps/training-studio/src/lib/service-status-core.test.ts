import { describe, expect, it } from 'vitest';
import { messageSegments, parseServiceStatus } from './service-status-core';

describe('parseServiceStatus', () => {
  it('fails open on missing or malformed values', () => {
    expect(parseServiceStatus(null)).toEqual({ available: true, message: null });
    expect(parseServiceStatus({ available: 'no', message: 42 })).toEqual({
      available: true,
      message: null,
    });
  });

  it('keeps a disabled status and its message, dropping blank messages', () => {
    expect(parseServiceStatus({ available: false, message: ' Down for maintenance ' })).toEqual({
      available: false,
      message: 'Down for maintenance',
    });
    expect(parseServiceStatus({ available: true, message: '  ', blockedModels: ['x'] })).toEqual({
      available: true,
      message: null,
    });
  });
});

describe('messageSegments', () => {
  it('renders strong and http(s) links, leaving other markdown as text', () => {
    expect(
      messageSegments(
        'Training is **slow**, see [status](https://status.civitai.com) or [x](javascript:alert(1)).'
      )
    ).toEqual([
      { kind: 'text', text: 'Training is ' },
      { kind: 'strong', text: 'slow' },
      { kind: 'text', text: ', see ' },
      { kind: 'link', text: 'status', href: 'https://status.civitai.com' },
      { kind: 'text', text: ' or ' },
      { kind: 'text', text: '[x](javascript:alert(1)' },
      { kind: 'text', text: ').' },
    ]);
  });
});
