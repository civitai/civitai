import { Model } from '@prisma/client';

export const models = [
  {
    name: 'Model 1',
    description:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    type: 'Checkpoint',
    trainedWords: ['jump', 'roll over', 'heel', 'fetch'],
    nsfw: false,
  },
];
