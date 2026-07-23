import { describe, it, expect } from 'vitest';
import { getChallengeDisplayUser } from './challenge.utils';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import type { ChallengeDisplayUser, ChallengeJudgeInfo } from '~/server/schema/challenge.schema';

const creator: ChallengeDisplayUser = {
  id: 10,
  username: 'realCreator',
  image: 'creator.png',
  profilePicture: null,
  cosmetics: null,
  deletedAt: null,
};

const judge: ChallengeJudgeInfo = {
  id: 1, // ChallengeJudge row id — must NOT leak into the author id
  userId: 99,
  name: 'CivBot the Judge',
  bio: null,
  username: 'CivBot',
  image: 'civbot.png',
  deletedAt: null,
  profilePicture: null,
  cosmetics: null,
};

describe('getChallengeDisplayUser', () => {
  it('User challenge shows the real creator', () => {
    expect(getChallengeDisplayUser({ source: ChallengeSource.User, createdBy: creator, judge })).toBe(
      creator
    );
  });

  it('Mod challenge shows the judge, keyed on the judge userId (not the ChallengeJudge id)', () => {
    const author = getChallengeDisplayUser({ source: ChallengeSource.Mod, createdBy: creator, judge });
    expect(author).toEqual({
      id: 99,
      username: 'CivBot',
      image: 'civbot.png',
      profilePicture: null,
      cosmetics: null,
      deletedAt: null,
    });
  });

  it('System challenge shows the judge (its createdBy already is the judge account)', () => {
    const systemCreator: ChallengeDisplayUser = { ...creator, id: 99, username: 'CivBot' };
    const author = getChallengeDisplayUser({
      source: ChallengeSource.System,
      createdBy: systemCreator,
      judge,
    });
    expect(author.id).toBe(99);
    expect(author.username).toBe('CivBot');
  });

  it('non-User with no judge falls back to the creator', () => {
    expect(
      getChallengeDisplayUser({ source: ChallengeSource.Mod, createdBy: creator, judge: null })
    ).toBe(creator);
  });
});
