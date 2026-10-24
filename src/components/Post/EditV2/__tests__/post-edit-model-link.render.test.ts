// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { PostEditModelLink } from '~/components/Post/EditV2/PostEditModelLink';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(props: { modelId: number | null; modelVersionId: number | null }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(MantineProvider, null, React.createElement(PostEditModelLink, props))
    )
  );
  return host;
}

describe('PostEditModelLink', () => {
  it('links to the model at the post’s version, in the same tab', () => {
    const link = render({ modelId: 3, modelVersionId: 5 }).querySelector('a');

    expect(link?.textContent).toBe('View Model');
    expect(link?.getAttribute('href')).toBe('/models/3?modelVersionId=5');
    expect(link?.getAttribute('target')).toBeNull();
  });

  it.each([
    ['has no model version', { modelId: null, modelVersionId: null }],
    ['has a version but its model is unknown', { modelId: null, modelVersionId: 5 }],
    ['has a model but no version', { modelId: 3, modelVersionId: null }],
  ])('shows no link when the post %s', (_, props) => {
    expect(render(props).querySelector('a')).toBeNull();
  });
});
