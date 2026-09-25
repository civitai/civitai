import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// The write paths are one-liners inside services whose import graphs are too large to run
// here; this pins that each one still hands its entity to the text scan (or, for Challenge
// edits, still re-pins the moderator override).
const read = (file: string) => readFileSync(path.resolve(__dirname, '../../../../..', file), 'utf8');

function functionBody(file: string, start: string) {
  const text = read(file);
  const from = text.indexOf(start);
  expect(from, `${start} not found in ${file}`).toBeGreaterThan(-1);
  const to = text.indexOf('\nexport ', from + start.length);
  return text.slice(from, to === -1 ? undefined : to);
}

const cases: [file: string, start: string, call: string, times: number][] = [
  ['src/server/services/challenge.service.ts', 'export async function upsertChallenge(', 'await pinModeratorNsfwLevel(tx, id);', 1],
  ['src/server/services/challenge.service.ts', 'export async function upsertUserChallenge(', 'await pinModeratorNsfwLevel(tx, id);', 1],
  ['src/server/services/challenge.service.ts', 'export async function upsertUserChallenge(', 'await scanUserChallenge(', 2],
  ['src/server/services/challenge.service.ts', 'export async function scanUserChallenge(', 'onActiveSkip: (reason) => settleSkippedChallengeScan(challengeId, reason)', 1],
  ['src/server/services/model.service.ts', 'export const upsertModel', 'submitModelTextModeration({', 1],
  ['src/server/services/model.service.ts', 'export async function applyModelContentChange', 'submitModelTextModeration({', 1],
  ['src/server/services/model-version.service.ts', 'export const upsertModelVersion', "scanEntityInBackground({ entityType: 'Model', entityId: version.modelId })", 2],
  ['src/server/services/model-version.service.ts', 'export async function applyModelVersionContentChange', "if (!context) scanEntityInBackground({ entityType: 'Model', entityId: modelId })", 1],
  ['src/server/services/model-version.service.ts', 'export const mergeVersions', "scanEntityInBackground({ entityType: 'Model', entityId: modelId })", 1],
  ['src/server/services/model.service.ts', 'export const privateModelFromTraining', "scanEntityInBackground({ entityType: 'Model', entityId: result.id })", 1],
  ['src/server/services/model.service.ts', 'export async function migrateResourceToCollection', "scanEntityInBackground({ entityType: 'Model', entityId })", 1],
  ['src/server/services/post.service.ts', 'export const createPost', "scanEntityInBackground({ entityType: 'Post', entityId: post.id })", 1],
  ['src/server/services/post.service.ts', 'export const updatePost', "scanEntityInBackground({ entityType: 'Post', entityId: post.id })", 1],
  ['src/server/services/blocks/block-post.service.ts', 'export async function writeBlockPost', "scanEntityInBackground({ entityType: 'Post', entityId: post.id })", 1],
  ['src/server/services/bounty.service.ts', 'export const upsertBounty', "scanEntityInBackground({ entityType: 'Bounty', entityId: updated.id })", 1],
  ['src/server/services/bounty.service.ts', 'export const upsertBounty', "scanEntityInBackground({ entityType: 'Bounty', entityId: created.id })", 1],
  ['src/server/services/bounty.service.ts', 'export async function applyBountyContentChange', "scanEntityInBackground({ entityType: 'Bounty', entityId: id })", 1],
  ['src/server/services/bountyEntry.service.ts', 'export const upsertBountyEntry', "scanEntityInBackground({ entityType: 'BountyEntry', entityId: result.id })", 1],
];

describe('text-scan write-path wiring', () => {
  it.each(cases)('%s → %s', (file, start, call, times) => {
    const body = functionBody(file, start);
    expect(body.split(call).length - 1, `${call} in ${start}`).toBeGreaterThanOrEqual(times);
  });
});
