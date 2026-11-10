// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContainerProvider,
  useContainerProviderStore,
} from '~/components/ContainerProvider/ContainerProvider';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

const NAME = 'query-test';

function mount(unmeasured: boolean | undefined) {
  const reads: boolean[] = [];
  function Probe() {
    reads.push(useContainerQuery({ type: 'max-width', width: 'sm', unmeasured }));
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(ContainerProvider, { containerName: NAME }, createElement(Probe)));
  });
  return { reads, unmount: () => act(() => root.unmount()) };
}

const measure = (inlineSize: number) =>
  act(() => {
    useContainerProviderStore.setState({ [NAME]: { inlineSize, blockSize: 0 } });
  });

let unmount: () => void = () => undefined;
afterEach(() => {
  unmount();
  useContainerProviderStore.setState({}, true);
});

describe('useContainerQuery before the container is measured', () => {
  it('answers with the unmeasured guess', () => {
    const h = mount(true);
    unmount = h.unmount;
    expect(h.reads.at(-1)).toBe(true);
  });

  it('answers false without a guess', () => {
    const h = mount(undefined);
    unmount = h.unmount;
    expect(h.reads.at(-1)).toBe(false);
  });

  it('drops the guess once the container reports a width', () => {
    const h = mount(true);
    unmount = h.unmount;
    measure(1200);
    expect(h.reads.at(-1)).toBe(false);
    measure(400);
    expect(h.reads.at(-1)).toBe(true);
  });
});
