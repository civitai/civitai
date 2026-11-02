import { afterEach, describe, expect, it } from 'vitest';
import { load } from './+layout.server';

const event = (user?: { username: string }) => ({ locals: { user } }) as never;

afterEach(() => {
  delete process.env.CIVITAI_APP_URL;
  delete process.env.KNIGHTS_CONVERSION_ENABLED;
});

describe('layout load', () => {
  it('points "Back to Civitai" at the configured main app, without a trailing slash', () => {
    process.env.CIVITAI_APP_URL = 'https://main.example/';
    expect(load(event())).toMatchObject({ civitaiUrl: 'https://main.example' });
  });

  it('falls back to civitai.com', () => {
    expect(load(event())).toMatchObject({ civitaiUrl: 'https://civitai.com', player: null });
  });

  it('hands the menu the signed-in player', () => {
    expect(load(event({ username: 'Sir' }))).toMatchObject({ player: { username: 'Sir' } });
  });

  it('offers "Convert gold" only while conversion is on', () => {
    expect(load(event())).toMatchObject({ conversionOpen: false });
    process.env.KNIGHTS_CONVERSION_ENABLED = 'true';
    expect(load(event())).toMatchObject({ conversionOpen: true });
  });
});
