import { describe, expect, it } from 'vitest';
import {
  describeBlockAction,
  isBlockActionDetail,
  READ_SCOPE_LABELS,
  type BlockActionDetail,
} from '~/shared/constants/block-action-detail';

describe('isBlockActionDetail', () => {
  it('accepts an object with a non-empty string action', () => {
    expect(isBlockActionDetail({ action: 'tip' })).toBe(true);
    expect(isBlockActionDetail({ action: 'storage.set', key: 'k' })).toBe(true);
  });
  it('rejects non-objects, null, and missing/empty action', () => {
    expect(isBlockActionDetail(null)).toBe(false);
    expect(isBlockActionDetail(undefined)).toBe(false);
    expect(isBlockActionDetail('tip')).toBe(false);
    expect(isBlockActionDetail(42)).toBe(false);
    expect(isBlockActionDetail({})).toBe(false);
    expect(isBlockActionDetail({ action: '' })).toBe(false);
    expect(isBlockActionDetail({ action: 5 })).toBe(false);
  });
});

describe('describeBlockAction', () => {
  it('tip: renders amount + resolved @username', () => {
    const d: BlockActionDetail = { action: 'tip', amount: 500, toUserId: 7, outcome: 'ok' };
    expect(describeBlockAction(d, { username: 'alice' })).toBe('Tipped 500 Buzz to @alice');
  });
  it('tip: falls back to a user id when the name is unresolved', () => {
    const d: BlockActionDetail = { action: 'tip', amount: 1000, toUserId: 7 };
    expect(describeBlockAction(d)).toBe('Tipped 1,000 Buzz to user #7');
  });
  it('tip: appends a resolved ModelVersion subject name when present', () => {
    const d: BlockActionDetail = {
      action: 'tip',
      amount: 5,
      toUserId: 7,
      entityType: 'ModelVersion',
      entityId: 99,
    };
    expect(describeBlockAction(d, { username: 'bob', subjectName: 'DreamXL v2' })).toBe(
      'Tipped 5 Buzz to @bob on DreamXL v2'
    );
  });
  it('tip: renders a safe generic subject for a non-ModelVersion entity (no name, no empty "on ")', () => {
    const d: BlockActionDetail = {
      action: 'tip',
      amount: 5,
      toUserId: 7,
      entityType: 'Image',
      entityId: 42,
    };
    // No subjectName supplied (the view only names ModelVersions) → generic.
    expect(describeBlockAction(d, { username: 'bob' })).toBe('Tipped 5 Buzz to @bob on this image');
  });
  it('tip: renders a generic subject when a ModelVersion name is still unresolved', () => {
    const d: BlockActionDetail = {
      action: 'tip',
      amount: 5,
      toUserId: 7,
      entityType: 'ModelVersion',
      entityId: 99,
    };
    expect(describeBlockAction(d, { username: 'bob' })).toBe(
      'Tipped 5 Buzz to @bob on this model version'
    );
  });
  it('tip: no entity ref → just recipient + amount (never a dangling "on ")', () => {
    const d: BlockActionDetail = { action: 'tip', amount: 500, toUserId: 7 };
    expect(describeBlockAction(d, { username: 'alice' })).toBe('Tipped 500 Buzz to @alice');
  });
  it('workflow.submit: renders the spend (absolute of a negative amount)', () => {
    const d: BlockActionDetail = { action: 'workflow.submit', amount: -120, outcome: 'ok' };
    expect(describeBlockAction(d)).toBe('Generated an image (spent 120 Buzz)');
  });
  it('workflow.submit: marks a failed outcome and omits a zero amount', () => {
    const d: BlockActionDetail = { action: 'workflow.submit', amount: 0, outcome: 'failed' };
    expect(describeBlockAction(d)).toBe('Generated an image — failed');
  });
  it('settings.update', () => {
    expect(describeBlockAction({ action: 'settings.update' })).toBe('Saved your block settings');
  });
  it('storage.set / delete / increment include the key', () => {
    expect(describeBlockAction({ action: 'storage.set', key: 'prefs' })).toBe(
      'Wrote app storage "prefs"'
    );
    expect(describeBlockAction({ action: 'storage.delete', key: 'prefs' })).toBe(
      'Deleted app storage "prefs"'
    );
    expect(describeBlockAction({ action: 'storage.increment', key: 'plays:5' })).toBe(
      'Bumped shared counter "plays:5"'
    );
  });
  it('unknown / forward-compat action code renders a safe generic line', () => {
    expect(describeBlockAction({ action: 'future.something' })).toBe('Performed an app action');
  });
});

describe('READ_SCOPE_LABELS', () => {
  it('maps the known passive-read scopes to friendly labels', () => {
    expect(READ_SCOPE_LABELS['buzz:read:self']).toBe('Read your Buzz balance/history');
    expect(READ_SCOPE_LABELS['user:read:self']).toBe('Read your viewer profile');
  });
});
