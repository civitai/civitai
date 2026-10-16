import { describe, expect, it } from 'vitest';

import { trainingServiceStatusSchema } from '~/server/schema/training.schema';
import { parseServiceStatus } from '../../../apps/training-studio/src/lib/service-status-core';

// The embed hands `training.getStatus` to the element, which fails open (`available: true`) on
// anything it can't read — so a renamed field would silently drop the outage banner and re-enable
// Start. No shared import spans the main app and apps/*, so this pins the two sides together.
describe('embedded Training Studio service status', () => {
  it("reads the main app's disabled status as disabled", () => {
    const status = trainingServiceStatusSchema.parse({ available: false, message: 'Paused' });
    expect(parseServiceStatus(status)).toEqual({ available: false, message: 'Paused' });
  });

  it("reads the main app's default status as available with no banner", () => {
    expect(parseServiceStatus(trainingServiceStatusSchema.parse({}))).toEqual({
      available: true,
      message: null,
    });
  });
});
