import { Anchor, Text, Title } from '@mantine/core';
import Image from 'next/image';
import Link from 'next/link';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';

export function ChallengeHero() {
  return (
    <div className="relative -mt-4 mb-4 overflow-hidden bg-gray-1 dark:bg-dark-9 dark:text-white">
      <MasonryContainer>
        <div className="mt-6 w-full overflow-hidden rounded-lg">
          <Image
            src="/images/daily-challenge-hero.png"
            alt="daily challenge banner with cookies flying and a coffee making machine made out of cookies"
            width={1600}
            height={400}
            className="mx-auto rounded-lg"
          />
        </div>
        <div className="flex h-full flex-col gap-2 py-6">
          <Title order={2} className="font-semibold">
            Daily Generation Challenges
          </Title>
          <Text size="lg" className="text-shadow-default">
            Introducing Daily Challenges! Compete in daily creative challenges, showcase your
            talent, and earn Buzz! 🏆 Click{' '}
            <Link href="/articles/9196" passHref legacyBehavior>
              <Anchor>here</Anchor>
            </Link>{' '}
            to learn more and join the fun! 🎉
          </Text>
        </div>
      </MasonryContainer>
    </div>
  );
}
