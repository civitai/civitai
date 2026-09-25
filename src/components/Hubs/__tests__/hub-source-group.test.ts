// @vitest-environment happy-dom
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `addToGroup` holds two decisions that exist nowhere else: the cap is spent on a NEW
// tag but not on one being MOVED into the group, and a tag held on the other side of
// `exclude` is refused with a message rather than moved. The transform they wrap is
// tested; the decisions are not, at any layer.
const { errorNotification, pickTag } = vi.hoisted(() => ({
  errorNotification: vi.fn(),
  // What the picker inside the popover hands back when a row is clicked.
  pickTag: { value: { type: 'Tag', targetId: 0, alias: '' } as Record<string, unknown> },
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: errorNotification,
}));

// Stubbed down to one button per instance. The picker is a sibling of the thing under
// test — it owns searching, not the group rules — and rendering it for real would drag
// tRPC and a debounce into a test about two `if`s.
//
// 🔴 The click MUST mirror the real row's toggle — `isAdded(item) ? onRemove : onAdd`
// (HubSourceInput's `Row`). A stub that always calls `onAdd` cannot see `isAdded` at
// all, and `isAdded` is where the group affordance actually broke: marking a tag the
// hub holds elsewhere as "added" routes the click to `onRemove`, so the move becomes a
// deletion. Measured — with the naive stub, that regression left all five green.
vi.mock('~/components/Hubs/HubSourceInput', () => ({
  HubSourceInput: ({
    onAdd,
    onRemove,
    isAdded,
    only,
  }: {
    onAdd: (item: Record<string, unknown>) => void;
    onRemove: (item: Record<string, unknown>) => void;
    isAdded: (item: Record<string, unknown>) => boolean;
    only?: string;
  }) =>
    // `data-only` so the group popover's picker is tellable from the editor's own. They
    // call different code — `addToGroup` vs `addSource` — and clicking the wrong one
    // silently tests the wrong thing.
    createElement(
      'button',
      {
        type: 'button',
        'data-only': only ?? 'none',
        onClick: () => (isAdded(pickTag.value) ? onRemove(pickTag.value) : onAdd(pickTag.value)),
      },
      'pick'
    ),
}));

import type * as Notifications from '~/utils/notifications';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { HubSourceEditor } from '~/components/Hubs/HubSourceEditor';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

// No JSX on purpose: the `unit` project's include is `*.test.ts`, so a `.tsx` test
// file is collected by NOTHING and reports zero tests rather than failing.
function render(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(createElement(MantineProvider, null, element));
  });
  return container;
}

const source = (over: Partial<HubSourceValue> & Pick<HubSourceValue, 'targetId'>): HubSourceValue =>
  ({
    type: UserHubSourceType.Tag,
    alias: `t${over.targetId}`,
    enabled: true,
    exclude: false,
    index: 0,
    groupKey: null,
    ...over,
  } as HubSourceValue);

/**
 * Open the first group's `+` popover and click a row in it.
 *
 * Async because the Popover dropdown mounts a tick after the trigger. Waiting for a
 * state that ARRIVES is safe — nothing takes it away again — unlike waiting on one that
 * deletes itself.
 */
async function addToFirstGroup(container: HTMLElement) {
  const plus = container.querySelector<HTMLElement>('[aria-label="Require another tag"]');
  if (!plus) throw new Error('no add-to-group control rendered');
  await act(async () => {
    plus.click();
  });

  const pick = document.querySelector<HTMLElement>('button[data-only="tags"]');
  if (!pick) throw new Error('picker did not open');
  await act(async () => {
    pick.click();
  });
}

const renderEditor = (value: HubSourceValue[]) => {
  const onChange = vi.fn();
  const container = render(
    createElement(HubSourceEditor, { value, onChange, emptyMessage: 'empty' })
  );
  return { container, onChange };
};

beforeEach(() => {
  document.body.innerHTML = '';
  errorNotification.mockClear();
  pickTag.value = { type: UserHubSourceType.Tag, targetId: 500, alias: 'swimsuit' };
});

describe('adding a tag to a group', () => {
  it('MOVES a tag the hub already holds even when the hub is full', async () => {
    // 🔴 The cap is conditional for exactly this reason: a move adds no row. Making it
    // unconditional means a full hub cannot group two tags it already holds — the dead
    // end the move branch was written to fix, reintroduced one layer up where the
    // transform's own tests cannot see it.
    const value = [
      source({ targetId: 1, groupKey: 0 }),
      source({ targetId: 500, index: 1 }),
      ...Array.from({ length: hubLimits.sourcesPerHub - 2 }, (_, i) =>
        source({ targetId: 1000 + i, type: UserHubSourceType.User, index: i + 2 })
      ),
    ];
    expect(value.filter((s) => !s.exclude)).toHaveLength(hubLimits.sourcesPerHub);

    const { container, onChange } = renderEditor(value);
    await addToFirstGroup(container);

    expect(errorNotification).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as HubSourceValue[];
    expect(next).toHaveLength(value.length);
    expect(next.find((s) => s.targetId === 500)?.groupKey).toBe(0);
  });

  it('refuses a NEW tag when the hub is full, and says so', async () => {
    // The negative control for the case above. Without it, deleting the cap check
    // entirely also passes — the editor would then write past `sourcesPerHub` and the
    // server would refuse the save with no indication of which click caused it.
    pickTag.value = { type: UserHubSourceType.Tag, targetId: 999, alias: 'new' };
    const value = [
      source({ targetId: 1, groupKey: 0 }),
      ...Array.from({ length: hubLimits.sourcesPerHub - 1 }, (_, i) =>
        source({ targetId: 1000 + i, type: UserHubSourceType.User, index: i + 1 })
      ),
    ];

    const { container, onChange } = renderEditor(value);
    await addToFirstGroup(container);

    expect(onChange).not.toHaveBeenCalled();
    expect(errorNotification).toHaveBeenCalledTimes(1);
  });

  it('🔴 refuses a kept-out tag rather than un-excluding it', async () => {
    // The transform returns the list untouched here; the message is the half only the
    // caller can show. If this lands on `onRemove` instead, the owner's exclusion is
    // silently deleted from inside a popover labelled "Require another tag".
    pickTag.value = { type: UserHubSourceType.Tag, targetId: 90, alias: 'violence' };
    const { container, onChange } = renderEditor([
      source({ targetId: 1, groupKey: 0 }),
      source({ targetId: 90, exclude: true, index: 1 }),
    ]);

    await addToFirstGroup(container);

    expect(onChange).not.toHaveBeenCalled();
    expect(errorNotification).toHaveBeenCalledTimes(1);
    const { error } = errorNotification.mock.calls[0][0];
    expect(error.message).toMatch(/never-show/i);
  });

  it('refuses anything that is not a tag', async () => {
    // A pasted Civitai link bypasses the pinned tab entirely — `resolveSource` answers
    // with whatever the link names — and the group would otherwise store it as a Tag
    // row carrying a model id.
    pickTag.value = { type: UserHubSourceType.Model, targetId: 4242, alias: 'Some Model' };
    const { container, onChange } = renderEditor([source({ targetId: 1, groupKey: 0 })]);

    await addToFirstGroup(container);

    expect(onChange).not.toHaveBeenCalled();
    expect(errorNotification).toHaveBeenCalledTimes(1);
  });
});

describe('the group chip', () => {
  it('shows a per-tag remove only once there is more than one tag', () => {
    // The two ✕ mean different things — one tag, or the whole group — and the chip
    // shows exactly one of them. Inverting the flag turns a single-tag removal into a
    // whole-group deletion.
    const grouped = renderEditor([
      source({ targetId: 1, groupKey: 0 }),
      source({ targetId: 2, groupKey: 0, index: 1 }),
    ]).container;

    expect(grouped.querySelectorAll('[aria-label$="from this hub"]')).toHaveLength(2);
    expect(grouped.querySelectorAll('[aria-label="Remove t1"]')).toHaveLength(0);

    const alone = renderEditor([source({ targetId: 1 })]).container;

    expect(alone.querySelectorAll('[aria-label$="from this hub"]')).toHaveLength(0);
    expect(alone.querySelectorAll('[aria-label="Remove t1"]')).toHaveLength(1);
  });
});
