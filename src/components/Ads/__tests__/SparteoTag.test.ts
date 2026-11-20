// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';

// next/script keeps a process-wide record of loaded srcs that resetModules cannot clear, so a
// second test would see the tag as already loaded. A plain <script> is what it inserts anyway.
vi.mock('next/script', () => ({
  default: (props: Record<string, unknown>) => React.createElement('script', props),
}));

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPARTEO = 1028;
// Shape of a TCF v2.2 getTCData / addEventListener payload in the EEA (GDPR applies).
const euTcData = (
  consents: Record<number, boolean>,
  eventStatus = 'tcloaded',
  purposes: Record<number, boolean> = { 1: true }
) => ({
  tcString: 'CQIYAAAQIYAAAAKAAAENBQFgAAAAAAAAAAAAAAAAAAAA',
  gdprApplies: true,
  eventStatus,
  cmpStatus: 'loaded',
  listenerId: 7,
  vendor: { consents, legitimateInterests: {} },
  purpose: { consents: purposes, legitimateInterests: {} },
});

type Listener = (tcData: unknown, success: boolean) => void;
let listeners: Listener[] = [];
function installCmp(first?: unknown) {
  listeners = [];
  window.__tcfapi = (command: string, _v: number, cb: Listener) => {
    if (command !== 'addEventListener') return;
    listeners.push(cb);
    if (first) cb(first, true);
  };
}
const emit = (tcData: unknown) => act(() => listeners.forEach((cb) => cb(tcData, true)));

const sparteoScripts = () => document.querySelectorAll('script[src*="flashb.id"]').length;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function mount() {
  const { SparteoTag } = await import('~/components/Ads/SparteoTag');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(SparteoTag)));
  await act(async () => undefined);
}

beforeEach(() => {
  delete (window as { __tcfapi?: unknown }).__tcfapi;
  document.querySelectorAll('script').forEach((s) => s.remove());
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = container = undefined;
  vi.useRealTimers();
});

describe('SparteoTag TCF gate', () => {
  it('EU visitor who refused all: no Sparteo script', async () => {
    installCmp(euTcData({}, 'tcloaded', {}));
    await mount();
    expect(sparteoScripts()).toBe(0);
  });

  it('EU visitor who accepted all: Sparteo script loads', async () => {
    installCmp(euTcData({ [SPARTEO]: true, 755: true }));
    await mount();
    expect(sparteoScripts()).toBe(1);
  });

  it('Sparteo vendor consent without Purpose 1 (device storage): no Sparteo script', async () => {
    installCmp(euTcData({ [SPARTEO]: true }, 'tcloaded', { 1: false, 3: true, 4: true }));
    await mount();
    expect(sparteoScripts()).toBe(0);
  });

  it('consent to other vendors but not Sparteo: no Sparteo script', async () => {
    installCmp(euTcData({ 755: true, [SPARTEO]: false }));
    await mount();
    expect(sparteoScripts()).toBe(0);
  });

  it('does not load on a provisional signal while the consent UI is up, then refuses', async () => {
    installCmp(euTcData({ [SPARTEO]: true }, 'cmpuishown'));
    await mount();
    expect(sparteoScripts()).toBe(0);
    await emit(euTcData({}, 'useractioncomplete'));
    await act(async () => undefined);
    expect(sparteoScripts()).toBe(0);
  });

  it('waits while the consent UI is up, then loads on accept', async () => {
    installCmp(euTcData({}, 'cmpuishown'));
    await mount();
    expect(sparteoScripts()).toBe(0);
    await emit(euTcData({ [SPARTEO]: true }, 'useractioncomplete'));
    await act(async () => undefined);
    expect(sparteoScripts()).toBe(1);
  });

  it('GDPR does not apply: Sparteo script loads', async () => {
    installCmp({ ...euTcData({}), gdprApplies: false });
    await mount();
    expect(sparteoScripts()).toBe(1);
  });

  it('no CMP ever appears: no Sparteo script', async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(sparteoScripts()).toBe(0);
  });

  it('a CMP that arrives after mount is picked up', async () => {
    vi.useFakeTimers();
    await mount();
    installCmp(euTcData({ [SPARTEO]: true }));
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(sparteoScripts()).toBe(1);
  });
});
