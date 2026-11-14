import { count } from '../format';
import { PROGRESSION } from './progression/config';
import { calculateFervor } from './progression/fervor';

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** A worked fervor sum, e.g. `400 × 100 × 80% × 80% = 25,600`, run through the formula and config the app scores with. */
export function fervorSum(correct: number, graded: number) {
  const ratio = correct / graded;
  return `${correct} × ${PROGRESSION.fervorScale} × ${percent(ratio)} × ${percent(ratio)} = ${count(
    calculateFervor({ correct, graded })
  )}`;
}

/** The "How fervor works" panel text; every number is read from the config the formula runs on. */
export function fervorCopy() {
  const { fervorScale: scale, fervorWindowDays: days, fervorAccuracyFloor: floor } = PROGRESSION;
  const correct = 400;
  const graded = 500;
  return {
    formula: `Correct judgments × ${scale} × your accuracy × your accuracy`,
    window: `Counts judgments you cast in the last ${days} days once their verdict is in. Older ones fall away, so fervor fades when you rest.`,
    accuracy: `Accuracy is the share you judged rightly. It never counts below ${percent(
      floor
    )}, and inconclusive images don't count either way. It counts twice, so careful judging beats guessing fast, and there is no cap on how many judgments count.`,
    example: `Example: ${correct} right of ${graded} judged is ${fervorSum(
      correct,
      graded
    )} fervor.`,
  };
}
