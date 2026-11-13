import { describe, expect, it, vi } from 'vitest';
import {
  acquireImageLoadSlot,
  MAX_CONCURRENT_IMAGE_LOADS,
} from '~/components/ResourceReview/ReviewCard/imageLoadLimiter';

describe('acquireImageLoadSlot', () => {
  const acquireMany = (n: number) => {
    const grants = Array.from({ length: n }, () => vi.fn());
    const slots = grants.map((grant) => acquireImageLoadSlot(grant));
    return { grants, slots };
  };

  it('grants the first few at once and queues the rest in order', () => {
    const { grants, slots } = acquireMany(MAX_CONCURRENT_IMAGE_LOADS + 2);
    const granted = () => grants.filter((g) => g.mock.calls.length).length;
    expect(granted()).toBe(MAX_CONCURRENT_IMAGE_LOADS);

    slots[0].release();
    expect(grants[MAX_CONCURRENT_IMAGE_LOADS]).toHaveBeenCalledTimes(1);
    expect(grants[MAX_CONCURRENT_IMAGE_LOADS + 1]).not.toHaveBeenCalled();

    slots.forEach((s) => s.release());
    expect(granted()).toBe(MAX_CONCURRENT_IMAGE_LOADS + 2);
  });

  it('never hands a slot to a card that gave up waiting, and a double release frees only one', () => {
    const { grants, slots } = acquireMany(MAX_CONCURRENT_IMAGE_LOADS + 2);
    slots[MAX_CONCURRENT_IMAGE_LOADS].release(); // gives up while queued

    slots[0].release();
    slots[0].release();
    expect(grants[MAX_CONCURRENT_IMAGE_LOADS]).not.toHaveBeenCalled();
    expect(grants[MAX_CONCURRENT_IMAGE_LOADS + 1]).toHaveBeenCalledTimes(1);

    slots.forEach((s) => s.release());
  });
});
