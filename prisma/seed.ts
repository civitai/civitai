import { ModelType, ReviewReactions, PrismaClient, ScanResultCode, ModelFileType, ModelStatus } from '@prisma/client';
import { getRandomInt } from '../src/utils/number-helpers';

const prisma = new PrismaClient({
  log: ['warn','error']
});

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
const modelTypes = Object.values(ModelType);
const modelStatus = Object.values(ModelStatus);
const descriptions = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.',
];
const reviewText = [
  'This model is awesome',
  'F u, ya stupid $#%^',
  'This is really cool',
  "I've seen better",
  'Your mom goes to college',
  'You must have been high when you made this',
];
const rating = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const tags = ['Pokemon', 'Lightning', 'Sunset', 'Orange', 'Kachow', 'Cute', 'Yellow'];

// const images = [
//   {
//     name: 'Pikachu',
//     url: 'https://s3.us-west-1.wasabisys.com/model-share/images/00009-3915424379-cf10-Euler%20a-s20.png',
//     height: 512,
//     width: 512,
//   },
// ];

const images = [...Array(50)].map((x, i) => {
  const index = i + 1 < 10 ? `0${i + 1}` : i + 1;
  return {
    name: `demo-image-${index}`,
    url: `https://s3.us-west-1.wasabisys.com/civitai-prod/images/demo-image-${index}.png`,
    height: 512,
    width: 512,
  };
});

const reactions: ReviewReactions[] = ['Like', 'Dislike', 'Laugh', 'Cry', 'Heart'];

async function seed() {
  console.log('Start seeding...');

  const user1 = await prisma.user.upsert({
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

  // const user2 = await prisma.user.upsert({
  //   where: { email: 'just.maier@gmail.com' },
  //   update: {},
  //   create: {
  //     name: 'Justin Maier',
  //     email: 'just.maier@gmail.com',
  //     image: 'https://avatars.githubusercontent.com/u/607609?v=4',
  //   },
  //   select: {
  //     id: true,
  //   },
  // });

  const user3 = await prisma.user.upsert({
    where: { email: 'manuel.ureh@hotmail.com' },
    update: {},
    create: {
      name: 'Manuel Emilio Urena',
      email: 'manuel.ureh@hotmail.com',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
    },
    select: {
      id: true,
    },
  });

  const userIds = [user1, user3].map((x) => x.id);

  /************
   * TAGS
   ************/
  const tagResults = await Promise.all(
    tags.map((name) =>
      prisma.tag.upsert({
        where: { name },
        update: {},
        create: {
          name,
        },
        select: { id: true },
      })
    )
  );

  /************
   * MODELS AND MODEL VERSIONS
   ************/
  const modelResults = await Promise.all(
    [...Array(10)].map((x, i) => {
      const status = getRandomItem(modelStatus);

      return prisma.model.create({
        data: {
          userId: getRandomItem(userIds),
          name: `Model ${i}`,
          description: getRandomItem(descriptions),
          type: getRandomItem(modelTypes),
          status,
          modelVersions: {
            create: [...Array(getRandomInt(1, 3))].map((y, j) => ({
              name: `Version ${j}`,
              description: getRandomItem(descriptions),
              trainedWords: getRandomItems(trainedWords, 3),
              steps: getRandomInt(1, 10),
              epochs: getRandomInt(1000, 3000),
              status,
              files: {
                create: [...Array(getRandomInt(1, 2))].map((z, k) => ({
                  name: `File ${k}`,
                  url: 'https://www.google.com/',
                  sizeKB: getRandomInt(1000000000, 4000000000),
                  type: [ModelFileType.Model, ModelFileType.TrainingData][k],
                  pickleScanResult: getRandomItem([ScanResultCode.Success, ScanResultCode.Danger, ScanResultCode.Error]),
                  virusScanResult: getRandomItem([ScanResultCode.Success, ScanResultCode.Danger, ScanResultCode.Error]),
                  scannedAt: new Date(),
                })),
              }
            })),
          },
        },
        select: {
          id: true,
          userId: true,
          modelVersions: {
            select: {
              id: true,
            },
          },
        },
      })
    })
  );

  /************
   * ADD TAGS TO MODELS
   ************/
  await Promise.all(
    modelResults.map(async ({ id: modelId }) =>
      prisma.tagsOnModels.createMany({
        data: getRandomItems(tagResults, getRandomInt(1, tagResults.length)).map(
          ({ id: tagId }) => ({
            modelId,
            tagId,
          })
        ),
      })
    )
  );

  /************
   * REVIEWS
   ************/
  await Promise.all(
    modelResults.map(async (result) => {
      const { id: modelId, modelVersions } = result;
      const { id: modelVersionId } = getRandomItem(modelVersions);
      await prisma.review.createMany({
        data: [...Array(getRandomInt(1, 5))].map((x) => ({
          modelId,
          modelVersionId,
          userId: getRandomItem(userIds),
          text: getRandomItem(reviewText),
          rating: getRandomItem(rating),
        })),
      });
    })
  );

  await Promise.all(
    modelResults.map(async ({ id: modelId, userId, modelVersions }) => {
      /************
       * MODEL VERSION IMAGES
       ************/
      await Promise.all(
        modelVersions.map(async ({ id: modelVersionId }, i) =>
          prisma.image.create({
            data: {
              userId,
              ...getRandomItem(images),
              imagesOnModels: {
                create: {
                  modelVersionId,
                  index: i,
                },
              },
            },
          })
        )
      );
      const reviewIds = await prisma.review.findMany({ where: { modelId }, select: { id: true } });
      /************
       * REVIEW IMAGES
       ************/
      await Promise.all(
        reviewIds.map(async ({ id: reviewId }) =>
          prisma.image.create({
            data: {
              userId,
              ...getRandomItem(images),
              imagesOnReviews: {
                create: {
                  reviewId,
                },
              },
            },
          })
        )
      );

      /************
       * REACTIONS
       ************/
      await Promise.all(
        reviewIds.map(async ({ id: reviewId }) => {
          await prisma.reviewReaction.createMany({
            data: [...Array(6)].map((x) => ({
              reviewId,
              userId: getRandomItem(userIds),
              reaction: getRandomItem(reactions),
            })),
          });
        })
      );
    })
  );
}

async function clearSeed() {
  await prisma.tag.deleteMany();
  await prisma.model.deleteMany();
  await prisma.image.deleteMany();
}

async function clearUser() {
  await prisma.user.delete({ where: { email: 'bkdiehl@gmail.com' } });
}

seed()
  .catch(async (e) => {
    console.error('ERROR:', e);
    await prisma.$disconnect();
    // process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
