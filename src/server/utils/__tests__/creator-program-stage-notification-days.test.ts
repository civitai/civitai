import { describe, expect, it } from 'vitest';
import type { CreatorProgramStageNotification } from '~/server/utils/creator-program.utils';
import {
  getPhases,
  getStageNotificationDays,
  isStageNotificationDay,
} from '~/server/utils/creator-program.utils';

const STAGES: CreatorProgramStageNotification[] = [
  'banking-phase-ending',
  'extraction-phase-started',
  'extraction-phase-ending',
];

// Every UTC day of the month, at the 00:00 the daily job fires plus a few seconds of scheduler lag.
function firingDays(stage: CreatorProgramStageNotification, year: number, monthIndex: number) {
  const days: string[] = [];
  const length = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  for (let d = 1; d <= length; d++) {
    const now = new Date(Date.UTC(year, monthIndex, d, 0, 0, 6));
    if (isStageNotificationDay(stage, now)) days.push(now.toISOString().slice(0, 10));
  }
  return days;
}

describe('creator program stage notification days', () => {
  it.each([
    // 30-day month: the Sep 2026 case, where banking-ending went out on the 26th.
    {
      label: '30-day',
      year: 2026,
      month: 8,
      bank: '2026-09-27',
      start: '2026-09-28',
      end: '2026-09-30',
    },
    {
      label: '31-day',
      year: 2026,
      month: 9,
      bank: '2026-10-28',
      start: '2026-10-29',
      end: '2026-10-31',
    },
    {
      label: 'February',
      year: 2027,
      month: 1,
      bank: '2027-02-25',
      start: '2027-02-26',
      end: '2027-02-28',
    },
    {
      label: 'leap February',
      year: 2028,
      month: 1,
      bank: '2028-02-26',
      start: '2028-02-27',
      end: '2028-02-29',
    },
  ])(
    '$label month sends each stage exactly once, on its day',
    ({ year, month, bank, start, end }) => {
      expect({
        'banking-phase-ending': firingDays('banking-phase-ending', year, month),
        'extraction-phase-started': firingDays('extraction-phase-started', year, month),
        'extraction-phase-ending': firingDays('extraction-phase-ending', year, month),
      }).toEqual({
        'banking-phase-ending': [bank],
        'extraction-phase-started': [start],
        'extraction-phase-ending': [end],
      });
    }
  );

  it.each([
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
    { year: 2027, month: 1 },
  ])('agrees with the phase getPhases reports at that moment ($year-$month)', ({ year, month }) => {
    const { bank, extraction } = getPhases({ month: new Date(Date.UTC(year, month, 15)) });
    const inBank = (d: Date) => d >= bank[0] && d <= bank[1];
    const inExtraction = (d: Date) => d > extraction[0] && d <= extraction[1];

    const days = getStageNotificationDays(new Date(Date.UTC(year, month, 15)));
    const bankingEnding = new Date(`${days['banking-phase-ending']}T00:00:06Z`);
    const extractionStarted = new Date(`${days['extraction-phase-started']}T00:00:06Z`);
    const extractionEnding = new Date(`${days['extraction-phase-ending']}T00:00:06Z`);

    // "Last day to bank": banking is open now and closed 24h later.
    expect([inBank(bankingEnding), inBank(new Date(+bankingEnding + 86_400_000))]).toEqual([
      true,
      false,
    ]);
    // "Extraction has begun": extraction is open now and was not open 24h earlier.
    expect([
      inExtraction(extractionStarted),
      inExtraction(new Date(+extractionStarted - 86_400_000)),
    ]).toEqual([true, false]);
    expect(inExtraction(extractionEnding)).toBe(true);
  });

  it('is decided by the UTC day, not the time of day it runs', () => {
    for (const stage of STAGES) {
      const day = getStageNotificationDays(new Date(Date.UTC(2026, 8, 15)))[stage];
      expect([
        isStageNotificationDay(stage, new Date(`${day}T00:00:00.000Z`)),
        isStageNotificationDay(stage, new Date(`${day}T23:59:59.999Z`)),
      ]).toEqual([true, true]);
    }
  });
});
