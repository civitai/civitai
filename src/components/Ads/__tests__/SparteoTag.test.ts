// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import {
  CONSENT_NOT_REQUIRED,
  ThirdPartyConsentContext,
} from '~/components/Consent/consent.context';

const state = vi.hoisted(() => ({
  src: 'https://tag.example.test/sparteo.js' as string | null,
  flags: { sparteoAds: true } as Record<string, boolean>,
  ads: { adsEnabled: true, useDirectAds: false, ready: true },
}));

vi.mock('~/components/Ads/sparteo.config', () => ({
  get SPARTEO_TAG_SRC() {
    return state.src;
  },
}));
vi.mock('~/components/Ads/AdsProvider', () => ({ useAdsContext: () => state.ads }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.flags }));

const { SparteoTag, SPARTEO_TAG_ID } = await import('~/components/Ads/SparteoTag');

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

function render(consentAllowed: boolean) {
  const consent = { ...CONSENT_NOT_REQUIRED, required: !consentAllowed, allowed: consentAllowed };
  act(() =>
    root?.render(
      React.createElement(
        ThirdPartyConsentContext.Provider,
        { value: consent },
        React.createElement(SparteoTag)
      )
    )
  );
}

function mount(consentAllowed = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render(consentAllowed);
}

const headTag = () => document.head.querySelector<HTMLScriptElement>(`script#${SPARTEO_TAG_ID}`);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.head.querySelectorAll(`#${SPARTEO_TAG_ID}`).forEach((el) => el.remove());
  document.body.innerHTML = '';
  state.src = 'https://tag.example.test/sparteo.js';
  state.flags = { sparteoAds: true };
  state.ads = { adsEnabled: true, useDirectAds: false, ready: true };
});

describe('SparteoTag', () => {
  it('adds one async head script when the flag is on and ads are allowed', () => {
    mount();
    const tag = headTag();
    expect(tag?.src).toBe('https://tag.example.test/sparteo.js');
    expect(tag?.async).toBe(true);
    expect(document.querySelectorAll(`#${SPARTEO_TAG_ID}`)).toHaveLength(1);
  });

  it('adds nothing with the flag off', () => {
    state.flags = {};
    mount();
    expect(headTag()).toBeNull();
  });

  it('adds nothing before ad consent', () => {
    mount(false);
    expect(headTag()).toBeNull();
  });

  it('adds the tag once the visitor accepts after the page has loaded', () => {
    mount(false);
    expect(headTag()).toBeNull();
    render(true);
    expect(headTag()?.src).toBe('https://tag.example.test/sparteo.js');
    render(true);
    expect(document.querySelectorAll(`#${SPARTEO_TAG_ID}`)).toHaveLength(1);
  });

  it('adds nothing until the TCF consent prompt has finished', () => {
    state.ads = { adsEnabled: true, useDirectAds: false, ready: false };
    mount();
    expect(headTag()).toBeNull();
  });

  it('adds nothing where the ad provider has ads off (gated page, member opt-out, blocked url)', () => {
    state.ads = { adsEnabled: false, useDirectAds: false, ready: true };
    mount();
    expect(headTag()).toBeNull();
  });

  it('adds nothing on the direct-ads domain', () => {
    state.ads = { adsEnabled: true, useDirectAds: true, ready: true };
    mount();
    expect(headTag()).toBeNull();
  });

  it('adds nothing until a tag source is configured', () => {
    state.src = null;
    mount();
    expect(headTag()).toBeNull();
  });
});
