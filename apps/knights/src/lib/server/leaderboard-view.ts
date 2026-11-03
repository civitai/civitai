import { count } from '../format';
import { PROGRESSION } from './progression/config';
import { calculateFervor } from './progression/fervor';

const DAY_MS = 86_400_000;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** Hours and minutes to the next UTC midnight, when the cached board is rebuilt, e.g. `6h 12m`. */
export function nextTally(now: Date): string {
  const left = DAY_MS - (now.getTime() % DAY_MS);
  const minutes = Math.floor(left / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The "How fervor works" panel text; every number is read from the config the formula runs on. */
export function fervorCopy() {
  const { fervorPerCorrect: per, fervorWindowDays: days, fervorAccuracyFloor: floor } = PROGRESSION;
  const correct = 400;
  const graded = 500;
  return {
    formula: `Correct judgments × ${per} × your accuracy`,
    window: `Counts judgments you cast in the last ${days} days once their verdict is in. Older ones fall away, so fervor fades when you rest.`,
    accuracy: `Accuracy is the share you judged rightly. It never counts below ${percent(
      floor
    )}, and inconclusive images don't count either way.`,
    example: `Example: ${correct} right of ${graded} judged is ${correct} × ${per} × ${percent(
      correct / graded
    )} = ${count(calculateFervor({ correct, graded }))} fervor.`,
  };
}
