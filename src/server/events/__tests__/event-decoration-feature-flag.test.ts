import { describe, expect, it } from 'vitest';
import { birthday2026 } from '~/server/events/birthday2026.event';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';

/**
 * The home blocks ask for a viewer's preview hats only when `definition.featureFlag` is on for
 * them; the server lets a viewer into the preview on the event's own `featureFlag`. Two spellings
 * of one rule, so they are pinned together: a definition naming a different flag would send the
 * request to the wrong viewers, or to none.
 */
describe('event decoration feature flags', () => {
  it('names the flag of the event it decorates', () => {
    const definition = getEventDecorationDefinition(birthday2026.name);
    expect(definition, 'no decoration definition for the birthday event').toBeDefined();
    expect(birthday2026.featureFlag).toBeDefined();
    expect(definition?.featureFlag).toBe(birthday2026.featureFlag);
  });
});
