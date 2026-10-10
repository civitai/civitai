import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } from '~/shared/constants/crucible.constants';

export const JUDGING_RULES: string[] = [
  `Pick the better of two. You can vote on each entry up to ${CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY} times.`,
  'You never see the same pair twice.',
  'Skipping is fine. It only resets your streak.',
];
