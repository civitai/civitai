import { describe, it, expect } from 'vitest';
import { updateCommentV3Schema } from '~/server/schema/commentv3.schema';

// Clearing the flag is restoreFromTos's alone; its SQL is covered in
// services/commentv3/__tests__/moderation.sql.behavior.test.ts.
describe('editing a comment', () => {
  it('cannot carry the ToS flag', () => {
    const input = updateCommentV3Schema.parse({ id: 7, content: 'edited', tosViolation: false });
    expect(input).not.toHaveProperty('tosViolation');
  });
});
