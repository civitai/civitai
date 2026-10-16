import { describe, expect, it } from 'vitest';
import { storylineContinuationAccess } from '~/server/services/storyline-placement.service';

/**
 * Who may continue a storyline, and whether they skip review. Every
 * combination of the three inputs, so a reordered rule shows up as the one
 * cell that changed rather than as a test someone has to think about.
 */
describe('storylineContinuationAccess', () => {
  it.each([
    // Closed (mode `off`, which Complete sets) refuses everyone, collaborators too.
    ['off', 'Anyone', false, 'closed'],
    ['off', 'Anyone', true, 'closed'],
    ['off', 'Collaborators', false, 'closed'],
    ['off', 'Collaborators', true, 'closed'],
    // An endorsed collaborator skips review whoever else may continue.
    ['review', 'Anyone', true, 'autoApprove'],
    ['review', 'Collaborators', true, 'autoApprove'],
    // A stranger: refused on a collaborators-only storyline, reviewed otherwise.
    ['review', 'Collaborators', false, 'collaboratorsOnly'],
    ['review', 'Anyone', false, 'review'],
  ] as const)('mode %s, %s may continue, collaborator %s: %s', (mode, who, collab, expected) => {
    expect(storylineContinuationAccess({ mode, whoCanContinue: who, isCollaborator: collab })).toBe(
      expected
    );
  });

  it('treats an unset whoCanContinue as anyone', () => {
    expect(storylineContinuationAccess({ mode: 'review', isCollaborator: false })).toBe('review');
  });

  // `auto` is a mode other surfaces have; a storyline row in it was hand-edited
  // and must not be read as "open without review".
  it('treats a mode the storyline surface does not allow as closed', () => {
    expect(storylineContinuationAccess({ mode: 'auto', isCollaborator: false })).toBe('closed');
  });
});
