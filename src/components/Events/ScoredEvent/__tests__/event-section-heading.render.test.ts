// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { IconTrophy } from '@tabler/icons-react';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('EventSectionHeading', () => {
  it('renders the title as the section h2, its icon, subtitle and right-hand controls', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(
            EventSectionHeading,
            { icon: IconTrophy, title: 'Team standings', subtitle: 'Updated hourly' },
            React.createElement('button', null, 'Points')
          )
        )
      )
    );
    const h2s = [...host.querySelectorAll('h2')].map((h) => h.textContent);
    expect(h2s).toEqual(['Team standings']);
    expect(host.querySelector('.mantine-ThemeIcon-root svg')).not.toBeNull();
    expect(host.querySelector('.mantine-Group-root')?.textContent).toBe(
      'Team standingsUpdated hourlyPoints'
    );
    expect(host.querySelector('button')?.textContent).toBe('Points');
  });

  // Centred on the title and subtitle together, the icon drifted down whenever a subtitle wrapped.
  it('aligns the icon to the title line, not the whole heading block', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(EventSectionHeading, {
            icon: IconTrophy,
            title: 'Team standings',
            subtitle: 'Updated hourly',
          })
        )
      )
    );
    const icon = host.querySelector<HTMLElement>('.mantine-ThemeIcon-root')!;
    const row = icon.parentElement!;
    expect(row.style.getPropertyValue('--group-align')).toBe('flex-start');
    expect(icon.className).toContain('-mt-0.5');
  });
});
