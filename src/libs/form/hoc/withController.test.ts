// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as z from 'zod';

// React 18.3 exposes `act` on the `react` export; our @types/react predates that typing.
const act = (React as unknown as { act: (callback: () => void) => void }).act;

vi.mock('@mantine/core', () => ({ LoadingOverlay: () => null }));

import { Form } from '~/libs/form/components/Form';
import { withController } from '~/libs/form/hoc/withController';
import { useForm } from '~/libs/form/hooks/useForm';

const schema = z.object({ content: z.string() });
type FormApi = ReturnType<typeof useForm<typeof schema, unknown>>;

type SeenProps = { reset?: number; value?: string };
let seen: SeenProps[];
const Probe = withController((props: SeenProps & { onChange?: (...events: any[]) => void }) => {
  seen.push({ reset: props.reset, value: props.value });
  return null;
});

function mount() {
  const container = document.createElement('div');
  const root = createRoot(container);
  const api: { form?: FormApi } = {};
  function Harness() {
    const form = useForm({ schema, defaultValues: { content: '<p>saved</p>' } });
    api.form = form;
    return React.createElement(
      Form,
      { form } as any,
      React.createElement(Probe, { name: 'content' } as any)
    );
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
  return { api, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  seen = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withController reset signal', () => {
  it('starts at 0 before any reset', () => {
    const { unmount } = mount();

    expect(seen.at(-1)).toEqual({ reset: 0, value: '<p>saved</p>' });
    unmount();
  });

  // An input that only reads its initial value (the rich text editor) re-syncs on this count,
  // so a reset that never reaches it leaves the old text on screen under the restored value.
  it('hands the input a higher reset count after the form is reset', () => {
    const { api, unmount } = mount();

    act(() => {
      api.form!.reset({ content: '<p>restored</p>' });
    });

    expect(seen.at(-1)).toEqual({ reset: 1, value: '<p>restored</p>' });
    unmount();
  });

  it('counts every reset', () => {
    const { api, unmount } = mount();

    act(() => {
      api.form!.reset({ content: '<p>one</p>' });
    });
    act(() => {
      api.form!.reset({ content: '<p>two</p>' });
    });

    expect(seen.at(-1)).toEqual({ reset: 2, value: '<p>two</p>' });
    unmount();
  });
});
