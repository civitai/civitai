import type { JudgingEngineKey } from '~/server/games/daily-challenge/challenge-judging-engine';
import type { DailyRubricSetKey } from '~/shared/constants/challenge.constants';
import dayjs from '~/shared/utils/dayjs';

// Judges are named, not numbered: ids differ per environment, names do not.
export const HOLIDAY_JUDGE_NAMES = {
  bot: 'Jolly CivBot',
  chan: 'Frost CivChan',
} as const;

export type DailyScheduleEntry = {
  /** What the day celebrates; the article writer uses it as the creative angle on the resource. */
  occasion: string;
  brief: string;
  set: DailyRubricSetKey;
  judge: string;
  engine?: JudgingEngineKey;
};

export type DailyPlan = {
  setKey: DailyRubricSetKey;
  occasion?: { name: string; brief: string };
  /** null = the configured default judge. */
  judgeName: string | null;
  engine?: JudgingEngineKey;
  source: 'schedule' | 'rotation';
};

const { bot, chan } = HOLIDAY_JUDGE_NAMES;

/** Keyed by the challenge's UTC start date. */
export const DAILY_CHALLENGE_SCHEDULE: Record<string, DailyScheduleEntry> = {
  '2026-12-01': {
    occasion: 'Advent opens',
    brief: 'The first door of an advent calendar opens onto a scene of its own.',
    set: 'story',
    judge: bot,
  },
  '2026-12-02': {
    occasion: 'First frost',
    brief: 'Everything rimed in ice crystals the morning after the first hard frost.',
    set: 'craft',
    judge: chan,
  },
  '2026-12-03': {
    occasion: 'Snow globe',
    brief: 'A world sealed inside a snow globe, just after someone shook it.',
    set: 'cute',
    judge: bot,
  },
  '2026-12-04': {
    occasion: 'National Cookie Day',
    brief: 'A holiday cookie bake that went gloriously wrong.',
    set: 'comedy',
    judge: chan,
  },
  '2026-12-05': {
    occasion: 'Krampusnacht',
    brief: 'The shadowy companion who follows St. Nicholas through the snow.',
    set: 'spooky',
    judge: bot,
  },
  '2026-12-06': {
    occasion: 'St. Nicholas Day',
    brief: 'Shoes left by the door, small gifts found at dawn.',
    set: 'cozy',
    judge: chan,
  },
  '2026-12-07': {
    occasion: 'Hanukkah',
    brief: 'Candlelight and the glow of the menorah on a winter night.',
    set: 'mood',
    judge: bot,
  },
  '2026-12-08': {
    occasion: 'Northern lights',
    brief: 'Aurora over a winter camp far from the city.',
    set: 'epic',
    judge: chan,
  },
  '2026-12-09': {
    occasion: 'Gift-wrapped wordplay',
    brief: 'A pun or double meaning you can see, wrapped up like a present.',
    set: 'clever',
    judge: bot,
  },
  '2026-12-10': {
    occasion: 'Nobel night',
    brief: "An inventor's grand reveal in front of a hushed winter crowd.",
    set: 'story',
    judge: chan,
  },
  '2026-12-11': {
    occasion: 'The office holiday party',
    brief: 'An office holiday party that has gone entirely sideways.',
    set: 'comedy',
    judge: bot,
  },
  '2026-12-12': {
    occasion: 'Poinsettia Day',
    brief: 'A crimson and gold still life built around winter blooms.',
    set: 'craft',
    judge: chan,
  },
  '2026-12-13': {
    occasion: 'St. Lucia and the Geminids',
    brief: 'Crowns of candlelight under a sky full of falling stars.',
    set: 'mood',
    judge: bot,
  },
  '2026-12-14': {
    occasion: 'The sledding hill',
    brief: 'Full speed downhill, snow spraying, nothing but motion.',
    set: 'action',
    judge: chan,
  },
  '2026-12-15': {
    occasion: 'Gingerbread architecture',
    brief: 'An ambitious build in gingerbread, icing and candy.',
    set: 'craft',
    judge: bot,
  },
  '2026-12-16': {
    occasion: 'Las Posadas',
    brief: 'A lantern procession winding through a village at night.',
    set: 'story',
    judge: chan,
  },
  '2026-12-17': {
    occasion: 'First flight',
    brief: 'A daring winter takeoff, on the anniversary of the first powered flight.',
    set: 'epic',
    judge: bot,
  },
  '2026-12-18': {
    occasion: 'Ugly Sweater Day',
    brief: 'The most magnificently ugly holiday sweater ever knitted.',
    set: 'comedy',
    judge: chan,
  },
  '2026-12-19': {
    occasion: 'The toy workshop',
    brief: 'A toy workshop running at full tilt the week before the holidays.',
    set: 'cute',
    judge: bot,
  },
  '2026-12-20': {
    occasion: 'The holiday market',
    brief: 'A holiday market after dark: stalls, steam and string lights.',
    set: 'mood',
    judge: chan,
  },
  '2026-12-21': {
    occasion: 'Winter solstice',
    brief: 'The longest night of the year, and what keeps it at bay.',
    set: 'epic',
    judge: bot,
  },
  '2026-12-22': {
    occasion: 'Dongzhi',
    brief: 'Warm bowls shared on the coldest night.',
    set: 'cozy',
    judge: chan,
  },
  '2026-12-23': {
    occasion: 'Festivus',
    brief: 'The airing of grievances, delivered with feeling.',
    set: 'comedy',
    judge: bot,
  },
  '2026-12-24': {
    occasion: 'Christmas Eve',
    brief: 'Waiting up by the window on Christmas Eve.',
    set: 'cozy',
    judge: chan,
  },
  '2026-12-25': {
    occasion: 'Christmas morning',
    brief: 'The first minutes of Christmas morning.',
    set: 'cute',
    judge: bot,
  },
  '2026-12-26': {
    occasion: 'Boxing Day and Kwanzaa',
    brief: 'The day after: a first candle lit, a story told by the fire.',
    set: 'story',
    judge: chan,
  },
  '2026-12-27': {
    occasion: 'Snowed in',
    brief: 'Cabin fever, told as a visual pun.',
    set: 'clever',
    judge: bot,
  },
  '2026-12-28': {
    occasion: 'The ice palace',
    brief: 'A palace carved entirely from ice.',
    set: 'epic',
    judge: chan,
  },
  '2026-12-29': {
    occasion: 'Winter noir',
    brief: 'A mystery in the snow, footprints leading somewhere they should not.',
    set: 'spooky',
    judge: bot,
  },
  '2026-12-30': {
    occasion: 'New Year resolutions',
    brief: 'Resolutions that will not survive January.',
    set: 'comedy',
    judge: chan,
  },
  '2026-12-31': {
    occasion: "New Year's Eve",
    brief: 'A midnight gala: elegant, glittering, never revealing.',
    set: 'glam',
    judge: bot,
  },
};

// Comedy is Fridays only; the other days cycle these so two days running never share a set.
const ROTATION_SETS: DailyRubricSetKey[] = [
  'craft',
  'mood',
  'story',
  'clever',
  'epic',
  'cute',
  'action',
  'cozy',
  'spooky',
  'glam',
];
const COMEDY_WEEKDAY = 5; // Friday

function dateKey(date: Date) {
  return dayjs(date).utc().format('YYYY-MM-DD');
}

/** Pure on the date: dailies for a batch are created in parallel, so nothing may read the day before. */
export function pickDailyRubricSet(date: Date): DailyRubricSetKey {
  const day = dayjs(date).utc().startOf('day');
  if (day.day() === COMEDY_WEEKDAY) return 'comedy';
  const dayNumber = Math.floor(day.valueOf() / 86_400_000);
  return ROTATION_SETS[dayNumber % ROTATION_SETS.length];
}

export function getDailyPlan(date: Date): DailyPlan {
  const entry = DAILY_CHALLENGE_SCHEDULE[dateKey(date)];
  if (entry)
    return {
      setKey: entry.set,
      occasion: { name: entry.occasion, brief: entry.brief },
      judgeName: entry.judge,
      engine: entry.engine,
      source: 'schedule',
    };
  return { setKey: pickDailyRubricSet(date), judgeName: null, source: 'rotation' };
}
