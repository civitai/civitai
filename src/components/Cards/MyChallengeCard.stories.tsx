import { ChallengeSource, ChallengeStatus, MediaType } from '~/shared/utils/prisma/enums';
import type { MyParticipatedChallengeItem } from '~/server/schema/challenge.schema';
import { MyChallengeCard } from './MyChallengeCard';

const now = new Date();
const daysFromNow = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

const baseImage = {
  id: 1,
  url: '81a26e2c-8bc2-4fda-a7c0-01fb129756d5', // Civitai-hosted sample edge-image key
  nsfwLevel: 1,
  hash: 'UBHLh[9Fofni~qofj[j@Rjayoffm-;WBj[fQ',
  width: 1024,
  height: 1024,
  type: MediaType.image,
};

const baseChallenge: MyParticipatedChallengeItem = {
  id: 101,
  title: 'Cybernetic Dreams',
  theme: 'Neon-soaked futures',
  invitation: null,
  coverImage: baseImage,
  startsAt: daysFromNow(-7),
  endsAt: daysFromNow(-1),
  status: ChallengeStatus.Completed,
  source: ChallengeSource.System,
  buzzType: 'yellow',
  nsfwLevel: 1,
  allowedNsfwLevel: 31,
  prizePool: 10000,
  entryCount: 342,
  commentCount: 58,
  modelVersionIds: [],
  collectionId: 55,
  createdById: -1,
  createdBy: {
    id: -1,
    username: 'civitai',
    image: null,
    profilePicture: null,
    cosmetics: null,
    deletedAt: null,
  },
  myEntryImage: baseImage,
  myPlace: null,
  myResult: 'entered',
  isLive: false,
  myEnteredAt: daysFromNow(-5),
};

const wrap = (data: MyParticipatedChallengeItem) => (
  <div style={{ width: 320 }}>
    <MyChallengeCard data={data} />
  </div>
);

/** Result state: 1st place — gold trophy badge, "View results" CTA */
export const Won = () =>
  wrap({ ...baseChallenge, myPlace: 1, myResult: 'won', title: 'Cybernetic Dreams — Champion' });

/** Result state: placed (non-1st) — dark medal badge, "View results" CTA */
export const Placed = () => wrap({ ...baseChallenge, myPlace: 3, myResult: 'placed' });

/** Result state: still under AI judging — blue hourglass badge, "View entry" CTA */
export const Judging = () =>
  wrap({
    ...baseChallenge,
    status: ChallengeStatus.Completing,
    myPlace: null,
    myResult: 'judging',
    isLive: false,
    endsAt: daysFromNow(0),
  });

/** Result state: entered, challenge still live — green check badge, filled-blue "Add another entry" CTA */
export const EnteredLive = () =>
  wrap({
    ...baseChallenge,
    status: ChallengeStatus.Active,
    myPlace: null,
    myResult: 'entered',
    isLive: true,
    startsAt: daysFromNow(-2),
    endsAt: daysFromNow(3),
  });

/** Result state: entered, challenge ended without placing — green check badge, "View results" CTA */
export const EnteredEnded = () =>
  wrap({
    ...baseChallenge,
    status: ChallengeStatus.Completed,
    myPlace: null,
    myResult: 'entered',
    isLive: false,
  });
