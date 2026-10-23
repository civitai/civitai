// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateSlot } from '~/components/Comics/CandidateImageModal';
import { CandidateImageModal } from '~/components/Comics/CandidateImageModal';
import { PanelUnlockActions } from '~/components/Comics/PanelUnlockActions';
import { NSFW_CAPPED, NSFW_CAPPED_MESSAGE } from '~/shared/orchestrator/workflow-data';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The yellow unlock charges without lifting the workflow's rating cap, so a panel whose mature
// output is above the cap must not offer it, in place on red or as a redirect from green.

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

function render(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, node)));
}

const buttonLabels = () =>
  Array.from(document.body.querySelectorAll('button, a')).map((el) => el.textContent?.trim());

const capped: CandidateSlot = { requiresUnlock: true, blockedReason: NSFW_CAPPED };
const upgradable: CandidateSlot = { requiresUnlock: true, blockedReason: 'canUpgrade' };
const clean: CandidateSlot = { key: 'clean-key', nsfwLevel: 1 };

function renderPicker(candidates: CandidateSlot[], domain: 'red' | 'green') {
  render(
    React.createElement(CandidateImageModal, {
      opened: true,
      onClose: () => undefined,
      candidates,
      currentImageUrl: null,
      onConfirm: () => undefined,
      onUnlock: domain === 'red' ? () => undefined : undefined,
      unlockHref: domain === 'green' ? 'https://civitai.red/comics/project/1/chapter/1' : null,
      isSelecting: false,
    })
  );
}

describe('comics candidate picker', () => {
  it('offers no yellow unlock when every locked result is capped', () => {
    renderPicker([capped, clean], 'red');
    expect(buttonLabels()).not.toContain('Unlock with yellow Buzz');
    expect(document.body.textContent).toContain(NSFW_CAPPED_MESSAGE);
  });

  it('offers the unlock when one locked result is within the cap', () => {
    renderPicker([upgradable, capped], 'red');
    expect(buttonLabels()).toContain('Unlock with yellow Buzz');
  });

  it('sends no one from green to red to unlock a capped result', () => {
    renderPicker([capped, clean], 'green');
    expect(buttonLabels()).not.toContain('Open on civitai.red');
  });

  it('sends a locked result within the cap from green to red', () => {
    renderPicker([upgradable, clean], 'green');
    expect(buttonLabels()).toContain('Open on civitai.red');
  });
});

describe('single-image panel unlock', () => {
  function renderActions(blockedReason: string, isGreen: boolean, onUnlock = vi.fn()) {
    render(
      React.createElement(PanelUnlockActions, {
        blockedReason,
        isGreen,
        unlockHref: 'https://civitai.red/comics/project/1/chapter/1',
        isUnlocking: false,
        onUnlock,
      })
    );
    return onUnlock;
  }

  it.each([
    ['red', false],
    ['green', true],
  ])('offers nothing to unlock a capped output on %s', (_domain, isGreen) => {
    renderActions(NSFW_CAPPED, isGreen);
    expect(buttonLabels()).toEqual([]);
    expect(document.body.textContent).toContain(NSFW_CAPPED_MESSAGE);
  });

  it('sends an output within the cap from green to red', () => {
    renderActions('siteRestricted', true);
    const link = document.body.querySelector('a');
    expect(link?.textContent?.trim()).toBe('Unlock on civitai.red');
    expect(link?.getAttribute('href')).toBe('https://civitai.red/comics/project/1/chapter/1');
  });

  it('unlocks an output within the cap on red', () => {
    const onUnlock = renderActions('canUpgrade', false);
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (el) => el.textContent?.trim() === 'Unlock'
    );
    act(() => button!.click());
    expect(onUnlock).toHaveBeenCalledOnce();
  });
});
