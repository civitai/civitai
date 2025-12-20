import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const filePath = new URL('../src/server/services/image.service.ts', import.meta.url);

test('metric order-by clauses are defined for gallery sorts', () => {
  const contents = fs.readFileSync(filePath, 'utf8');
  assert.ok(contents.includes('getMetricOrderBy'));
  assert.ok(
    contents.includes(
      'im."reactionCount" DESC, im."heartCount" DESC, im."likeCount" DESC, i."id" DESC'
    )
  );
  assert.ok(
    contents.includes('im."commentCount" DESC, im."reactionCount" DESC, i."id" DESC')
  );
  assert.ok(
    contents.includes('im."collectedCount" DESC, im."reactionCount" DESC, i."id" DESC')
  );
});
