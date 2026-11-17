import { describe, expect, it } from 'vitest';
import { isRuntimeRun, remixRunTags } from '~/shared/remix-apps/tags';

/**
 * The tray continues a runtime run through `advance` and treats a one-shot run as done. Make it
 * real and the other one-shot apps moved to the runtime, so a run's kind is read from its tags,
 * with the apps that were runtime before the tag existed read by slug.
 */
describe('isRuntimeRun', () => {
  const tagsOf = (slug: string, runtime: boolean) =>
    remixRunTags({ slug, runId: 'r0123456789abcdef0123', segment: 0, runtime });

  it('reads a run started on the runtime from its tag, whatever the app', () => {
    expect(isRuntimeRun('make-it-real', tagsOf('make-it-real', true))).toBe(true);
  });

  it('keeps a one-shot run started before the move one-shot, so it is not advanced', () => {
    expect(isRuntimeRun('make-it-real', tagsOf('make-it-real', false))).toBe(false);
    expect(isRuntimeRun('team-remix', tagsOf('team-remix', false))).toBe(false);
  });

  it('continues an untagged run of an app that was already on the runtime', () => {
    for (const slug of ['anime-it', 'pick-of-four', 'restyle'])
      expect(isRuntimeRun(slug, tagsOf(slug, false))).toBe(true);
  });
});
