import { describe, expect, it } from 'vitest';
import { messageSegments, parseServiceStatus } from './service-status-core';

describe('parseServiceStatus', () => {
  const open = { available: true, message: null, blockedModels: [], blockedModelReasons: {} };

  it('fails open on missing or malformed values', () => {
    expect(parseServiceStatus(null)).toEqual(open);
    expect(
      parseServiceStatus({
        available: 'no',
        message: 42,
        blockedModels: 'krea2',
        blockedModelReasons: 'x',
      })
    ).toEqual(open);
  });

  it('keeps a disabled status and its message, dropping blank messages', () => {
    expect(parseServiceStatus({ available: false, message: ' Down for maintenance ' })).toEqual({
      ...open,
      available: false,
      message: 'Down for maintenance',
    });
    expect(parseServiceStatus({ available: true, message: '  ' })).toEqual(open);
  });

  it('keeps the blocked models and their text reasons, dropping blank or non-text ones', () => {
    expect(
      parseServiceStatus({
        blockedModels: ['krea2', 7, ' ', 'sdxl'],
        blockedModelReasons: { krea2: ' Provider outage. ', sdxl: 42, flux_dev: '' },
      })
    ).toEqual({
      ...open,
      blockedModels: ['krea2', 'sdxl'],
      blockedModelReasons: { krea2: 'Provider outage.' },
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
