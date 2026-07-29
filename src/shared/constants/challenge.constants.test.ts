import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_ENTRY_HOUSE_CUT,
  CHALLENGE_MIN_ENTRY_FEE,
  getChallengeActiveLimit,
  getEntryPoolContribution,
} from '~/shared/constants/challenge.constants';

describe('challenge constants', () => {
  it('resolves tier active-challenge limits (fib), defaulting to 1', () => {
    expect(getChallengeActiveLimit('free')).toBe(1);
    expect(getChallengeActiveLimit('bronze')).toBe(2);
    expect(getChallengeActiveLimit('silver')).toBe(3);
    expect(getChallengeActiveLimit('gold')).toBe(5);
    expect(getChallengeActiveLimit('founder')).toBe(2);
    expect(getChallengeActiveLimit(undefined)).toBe(1);
    expect(getChallengeActiveLimit(null)).toBe(1);
    expect(getChallengeActiveLimit('mystery')).toBe(1);
  });

  it('nets the house cut out of the entry-fee pool contribution', () => {
    expect(getEntryPoolContribution(CHALLENGE_MIN_ENTRY_FEE)).toBe(
      CHALLENGE_MIN_ENTRY_FEE - CHALLENGE_ENTRY_HOUSE_CUT
    );
    expect(getEntryPoolContribution(CHALLENGE_ENTRY_HOUSE_CUT)).toBe(0);
    expect(getEntryPoolContribution(10)).toBe(0); // below the cut → clamps to 0, never negative
  });
});
