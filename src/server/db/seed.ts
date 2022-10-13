import { prisma } from './client';

const getRandomItem = <T>(array: T[]) => array[Math.floor(Math.random() * array.length)];
const getRandomItems = <T>(array: T[], quantity: number) => {
  const shuffled = [...array].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, quantity);
};
const trainedWords = [
  'jump',
  'roll over',
  'heel',
  'fetch',
  'go home',
  'do a barrel roll',
  'eat it',
];
const modelTypes = ['Checkpoint', 'TextualInversion', 'Hypernetwork'];
const descriptions = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.',
];

const models = [
  {
    name: 'Model 1',
    description: getRandomItem(descriptions),
    type: getRandomItem(modelTypes),
    trainedWords: getRandomItems(trainedWords, 3),
    nsfw: false,
  },
];

async function main() {
  const { id: userId } = await prisma.user.upsert({
    where: { email: 'bkdiehl@gmail.com' },
    update: {},
    create: {
      name: 'Briant Diehl',
      email: 'bkdiehl@gmail.com',
      image:
        'https://lh3.googleusercontent.com/a/ALm5wu3gJ6JJzkYRLbSmFQ5Z7Kybir8uEEhylcQS-gkoVg=s96-c',
    },
    select: {
      id: true,
    },
  });

  const { id: modelId, modelVersions } = await prisma.model.create({
    data: {
      userId,
      name: 'Model 1',
      description:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      type: 'Checkpoint',
      trainedWords: ['jump', 'roll over', 'heel', 'fetch'],
      nsfw: false,
      modelVersions: {
        create: [
          {
            name: 'Version 1',
            description: 'My first version',
            url: 'https://www.google.com/',
            sizeKB: 2452345,
            steps: 3,
            epochs: 3000,
          },
          {
            name: 'Version 2',
            description: 'My second version',
            url: 'https://www.google.com/',
            sizeKB: 5232445,
            steps: 4,
            epochs: 4000,
          },
        ],
      },
      tagsOnModels: {
        create: [
          {
            tag: {
              create: {
                name: 'Pokemon',
              },
            },
          },
          {
            tag: {
              create: {
                name: 'Epic',
              },
            },
          },
          {
            tag: {
              create: {
                name: 'Sunset',
              },
            },
          },
        ],
      },
    },
    select: {
      id: true,
      modelVersions: {
        select: {
          id: true,
        },
      },
    },
  });

  await prisma.review.createMany({
    data: [
      {
        modelId,
        userId,
        text: 'This model is awesome',
        rating: 10,
      },
      {
        modelId,
        userId,
        text: 'F u, ya stupid $#%^',
        rating: 1,
        nsfw: true,
      },
    ],
  });

  await Promise.all(
    modelVersions.map(async ({ id }) => {
      await prisma.image.create({
        data: {
          userId,
          name: 'Pikachoochoo',
          url: 'https://s3.us-west-1.wasabisys.com/model-share/images/00009-3915424379-cf10-Euler%20a-s20.png',
          height: 512,
          width: 512,
          imagesOnModels: {
            create: {
              modelId,
              modelVersionId: id,
              type: 'Example',
            },
          },
        },
      });
    })
  );

  const reviewIds = await prisma.review.findMany({ where: { modelId }, select: { id: true } });
  await Promise.all(
    reviewIds.map(async ({ id }) => {
      await prisma.image.create({
        data: {
          userId,
          name: 'Pikachoochoo',
          url: 'https://s3.us-west-1.wasabisys.com/model-share/images/00009-3915424379-cf10-Euler%20a-s20.png',
          height: 512,
          width: 512,
          imagesOnReviews: {
            create: {
              reviewId: id,
            },
          },
        },
      });
    })
  );

  await Promise.all(
    reviewIds.map(async ({ id }) => {
      await prisma.reviewReaction.createMany({
        data: [
          {
            reviewId: id,
            userId,
            reaction: 'Like',
          },
        ],
      });
    })
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
