import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showNotification, hideNotification } = vi.hoisted(() => ({
  showNotification: vi.fn(),
  hideNotification: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ showNotification, hideNotification }));

import { showImageHiddenNotification } from '../showImageHiddenNotification';

function findUndoButton(node: any): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.onClick) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findUndoButton(child);
    if (found) return found;
  }
}

describe('showImageHiddenNotification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers Undo', () => {
    showImageHiddenNotification({ imageId: 7, onUndo: vi.fn() });
    const arg = showNotification.mock.calls[0][0];
    expect(findUndoButton(arg.message).props.children).toBe('Undo');
  });

  it('Undo closes the toast and runs onUndo', () => {
    const onUndo = vi.fn();
    showImageHiddenNotification({ imageId: 7, onUndo });
    const arg = showNotification.mock.calls[0][0];
    findUndoButton(arg.message).props.onClick();
    expect(hideNotification).toHaveBeenCalledWith(arg.id);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
