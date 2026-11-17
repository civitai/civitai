// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CONSENT_NOT_REQUIRED,
  ThirdPartyConsentContext,
} from '~/components/Consent/consent.context';

const SPARTEO = 1028;
const EU_ACCEPT_ALL = {
  eventStatus: 'useractioncomplete',
  gdprApplies: true,
  purpose: {
    consents: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true },
    legitimateInterests: { 2: true, 7: true },
  },
  vendor: { consents: { [SPARTEO]: true }, legitimateInterests: { [SPARTEO]: true } },
};
const EU_REJECT_ALL = {
  eventStatus: 'useractioncomplete',
  gdprApplies: true,
  purpose: { consents: {}, legitimateInterests: {} },
  vendor: { consents: {}, legitimateInterests: {} },
};
const NO_GDPR = { eventStatus: 'tcloaded', gdprApplies: false };

const state = vi.hoisted(() => ({
  src: 'https://tag.example.test/sparteo.js' as string | null,
  flags: { sparteoAds: true } as Record<string, boolean>,
  ads: { adsEnabled: true, useDirectAds: false, ready: true },
}));

vi.mock('~/components/Ads/sparteo.config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get SPARTEO_TAG_SRC() {
      return state.src;
    },
  };
});
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.flags }));

const SparteoModule = await import('~/components/Ads/SparteoTag');
const { SparteoTag, SPARTEO_TAG_ID } = SparteoModule;

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TcfListener = (tcData: unknown, success: boolean) => void;
let tcfListeners: TcfListener[] = [];
let tcData: unknown = EU_ACCEPT_ALL;

function emitTcf(next: unknown) {
  tcData = next;
  act(() => tcfListeners.forEach((listener) => listener(next, true)));
}

let root: Root | undefined;

function render(consentAllowed: boolean) {
  const consent = { ...CONSENT_NOT_REQUIRED, required: !consentAllowed, allowed: consentAllowed };
  act(() =>
    root?.render(
      React.createElement(
        ThirdPartyConsentContext.Provider,
        { value: consent },
        React.createElement(SparteoTag, state.ads)
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

beforeEach(() => {
  tcfListeners = [];
  tcData = EU_ACCEPT_ALL;
  window.__tcfapi = (command: string, _version: number, callback: TcfListener) => {
    if (command !== 'addEventListener') return;
    tcfListeners.push(callback);
    callback(tcData, true);
  };
});

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
  it('adds one async head script for an EU visitor who accepts all', () => {
    mount();
    const tag = headTag();
    expect(tag?.src).toBe('https://tag.example.test/sparteo.js');
    expect(tag?.async).toBe(true);
    expect(tag?.getAttribute('data-cfasync')).toBe('false');
    expect(Array.isArray(window._hbdbrk)).toBe(true);
    expect(document.querySelectorAll(`#${SPARTEO_TAG_ID}`)).toHaveLength(1);
  });

  it('adds nothing for an EU visitor who rejects all', () => {
    tcData = EU_REJECT_ALL;
    mount();
    expect(headTag()).toBeNull();
  });

  it('adds nothing for an EU visitor who grants the purposes but not Sparteo as a vendor', () => {
    tcData = { ...EU_ACCEPT_ALL, vendor: { consents: {}, legitimateInterests: {} } };
    mount();
    expect(headTag()).toBeNull();
  });

  it('adds the tag where GDPR does not apply and site consent allows it', () => {
    tcData = NO_GDPR;
    mount();
    expect(headTag()).not.toBeNull();
  });

  it('adds nothing for a visitor who opted out on the site consent banner', () => {
    tcData = NO_GDPR;
    mount(false);
    expect(headTag()).toBeNull();
  });

  it('adds nothing while the TCF prompt is still showing, then once on accept', () => {
    tcData = { ...EU_ACCEPT_ALL, eventStatus: 'cmpuishown' };
    mount();
    expect(headTag()).toBeNull();
    emitTcf(EU_ACCEPT_ALL);
    expect(headTag()?.src).toBe('https://tag.example.test/sparteo.js');
    emitTcf(EU_ACCEPT_ALL);
    expect(document.querySelectorAll(`#${SPARTEO_TAG_ID}`)).toHaveLength(1);
  });

  it('adds the tag once the visitor accepts the site banner after the page has loaded', () => {
    tcData = NO_GDPR;
    mount(false);
    expect(headTag()).toBeNull();
    render(true);
    expect(headTag()).not.toBeNull();
  });

  it('adds nothing with the flag off', () => {
    state.flags = {};
    mount();
    expect(headTag()).toBeNull();
  });

  it('adds nothing until the CMP has answered', () => {
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

describe('tcfAllowsTag', () => {
  const tcf = { vendorId: SPARTEO, consentPurposes: [1, 3, 4], legIntPurposes: [2] };
  const allows = (data: unknown) =>
    SparteoModule.tcfAllowsTag(data as Parameters<typeof SparteoModule.tcfAllowsTag>[0], tcf);

  it('accepts purpose 2 on legitimate interest only when the vendor keeps its legitimate interest', () => {
    const consentOnly = { ...EU_ACCEPT_ALL.purpose.consents, 2: false };
    expect(
      allows({ ...EU_ACCEPT_ALL, purpose: { ...EU_ACCEPT_ALL.purpose, consents: consentOnly } })
    ).toBe(true);
    expect(
      allows({
        ...EU_ACCEPT_ALL,
        purpose: { ...EU_ACCEPT_ALL.purpose, consents: consentOnly },
        vendor: { consents: { [SPARTEO]: true }, legitimateInterests: {} },
      })
    ).toBe(false);
  });

  it('refuses when one required consent purpose is missing', () => {
    expect(
      allows({
        ...EU_ACCEPT_ALL,
        purpose: { ...EU_ACCEPT_ALL.purpose, consents: { 1: true, 2: true, 3: true } },
      })
    ).toBe(false);
  });

  it('treats an unknown gdprApplies as applying', () => {
    expect(allows({ ...EU_REJECT_ALL, gdprApplies: undefined })).toBe(false);
  });
});
