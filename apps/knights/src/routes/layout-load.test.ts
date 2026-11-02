import { afterEach, describe, expect, it } from 'vitest';
import { load } from './+layout.server';

afterEach(() => {
  delete process.env.CIVITAI_APP_URL;
});

describe('layout load', () => {
  it('points "Back to Civitai" at the configured main app, without a trailing slash', () => {
    process.env.CIVITAI_APP_URL = 'https://main.example/';
    expect(load({} as never)).toEqual({ civitaiUrl: 'https://main.example' });
  });

  it('falls back to civitai.com', () => {
    expect(load({} as never)).toEqual({ civitaiUrl: 'https://civitai.com' });
  });
});
