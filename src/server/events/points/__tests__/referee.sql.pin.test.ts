import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  eventPointsRefereeSql,
  eventPointsRefereeUsersSql,
} from '~/server/events/points/referee.sql';

// The referee's SQL is built from fragments it shares with the per-placement read. The fixtures were
// captured from main before that split; any change to them changes scoring, so it is deliberate or a
// bug, never a side effect of editing the shared fragments.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('referee SQL', () => {
  it('renders exactly as before the shared fragments', () => {
    expect(eventPointsRefereeSql).toBe(fixture('referee.sql.fixture.txt'));
    expect(eventPointsRefereeUsersSql).toBe(fixture('referee-users.sql.fixture.txt'));
  });
});
