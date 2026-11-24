import { describe, expect, it } from 'vitest';

import { capsAsPrivateGeneration } from '~/shared/utils/resource.utils';

const AIR = 'urn:air:sdxl:lora:orchestrator:blob@key';

describe('capsAsPrivateGeneration', () => {
  it.each([
    ['a private or unpublished version', { id: 1, isPrivate: true }, true],
    ['an in-app training epoch', { id: 1, epochDetails: { epochNumber: 3 } }, true],
    ['a raw-AIR Training Studio epoch', { id: -5, air: AIR }, true],
    ['a published version that carries its AIR', { id: 1, air: AIR }, false],
    ['a published version', { id: 1, isPrivate: false }, false],
  ])('%s', (_, resource, expected) => {
    expect(capsAsPrivateGeneration(resource)).toBe(expected);
  });
});
