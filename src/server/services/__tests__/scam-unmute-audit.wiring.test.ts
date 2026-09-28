import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('every main-app moderator unmute leaves a ModActivity row and releases open scam cases', () => {
  it('toggleMuteHandler records mute or unmute by the acting moderator', () => {
    const source = read('src/server/controllers/user.controller.ts');
    const body = source.slice(source.indexOf('export const toggleMuteHandler'));
    const handler = body.slice(0, body.indexOf('\nexport '));
    expect(handler).toContain('trackModActivity(ctx.user.id, {');
    expect(handler).toContain("activity: user.muted ? 'unmute' : 'mute'");
    expect(handler).toContain('clearedMuteFields(user.meta)');
    expect(handler).toContain('if (user.muted) await closeScamCasesOpenedBefore(id, new Date());');
  });

  it('the unmute endpoint records unmute by the actor', () => {
    const source = read('src/pages/api/mod/user/unmute.ts');
    expect(source).toContain('trackModActivity(actor.id, {');
    expect(source).toContain("activity: 'unmute'");
    expect(source).toContain('await closeScamCasesOpenedBefore(input.userId, new Date());');
  });
});
