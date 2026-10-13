// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import type { CompensationSource } from '~/server/schema/buzz.schema';
import {
  EARNINGS_SOURCE_STORAGE_KEY,
  useEarningsSource,
} from '~/components/Buzz/Rewards/useEarningsSource';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Snapshot = { source: CompensationSource; ready: boolean };

let container: HTMLDivElement;
let root: Root;
let renders: Snapshot[];
let setSource: (value: CompensationSource) => void;

function Probe() {
  const result = useEarningsSource();
  renders.push({ source: result.source, ready: result.ready });
  setSource = result.setSource;
  return null;
}

async function mount() {
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  renders = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('useEarningsSource', () => {
  it('restores License Fees after a reload', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('licenseFee'));
    await mount();
    expect(renders.at(-1)).toEqual({ source: 'licenseFee', ready: true });
  });

  it('restores Tips after a reload', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('tip'));
    await mount();
    expect(renders.at(-1)).toEqual({ source: 'tip', ready: true });
  });

  it('a selection made on one mount is what the next mount starts on', async () => {
    await mount();
    await act(async () => setSource('licenseFee'));
    await act(async () => root.unmount());

    renders = [];
    await mount();
    expect(renders.at(-1)).toEqual({ source: 'licenseFee', ready: true });
  });

  it('defaults to Compensation with nothing stored', async () => {
    await mount();
    expect(renders.at(-1)).toEqual({ source: 'compensation', ready: true });
  });

  it('falls back to Compensation for a value the query input would reject', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('buzz'));
    await mount();
    expect(renders.at(-1)).toEqual({ source: 'compensation', ready: true });
  });

  // The queries are gated on `ready`; if it could be true while the default is still showing,
  // a License Fees user would fetch Compensation on every load and then discard it.
  it('is never ready while still showing the pre-storage default', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('licenseFee'));
    await mount();
    expect(renders[0]).toEqual({ source: 'compensation', ready: false });
    expect(renders.filter((r) => r.ready && r.source !== 'licenseFee')).toEqual([]);
  });
});
