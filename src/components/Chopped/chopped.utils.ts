import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';
import type { GameState, GlobalState, NewGame } from '~/components/Chopped/chopped.shared-types';
import type { Difference } from '~/utils/object-helpers';
import { patch } from '~/utils/object-helpers';

// #region [state]
export const defaultGlobalState: GlobalState = {
  themes: [
    {
      id: 'lemon',
      name: 'Lemon',
      image: 'c59b5caf-7892-4756-8355-3bfcd945a5c1',
      resources: [
        'urn:air:sdxl:lora:civitai:303929@341209',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'egg',
      name: 'Egg',
      image: '70b87a5a-acfd-4e08-ae9a-09324f7cefab',
      resources: [
        'urn:air:sdxl:lora:civitai:255828@288399',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'pancake',
      name: 'Pancake',
      image: '38e2213c-488e-48b3-a203-54bf9b1e0399',
      resources: [
        'urn:air:sdxl:lora:civitai:302772@339987',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'watermelon',
      name: 'Watermelon',
      image: '2d4e4335-9fcb-4083-99b3-972dba6db4c5',
      resources: [
        'urn:air:sdxl:lora:civitai:507962@564577',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'roasted',
      name: 'Roasted',
      image: '07a2890b-dca5-4982-b5eb-32884aa286ae',
      resources: [
        'urn:air:sdxl:lora:civitai:497710@553293',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'salad',
      name: 'Salad',
      image: '5da51acb-1ac0-43e9-a42b-f115eb8e6f6e',
      resources: [
        'urn:air:sdxl:lora:civitai:484650@538994',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'grilled_steak',
      name: 'Grilled Steak',
      image: '05d051c0-f16c-4304-8cc3-bf9ef32d40ec',
      resources: [
        'urn:air:sdxl:lora:civitai:447029@497801',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'bread_crust',
      name: 'Bread Crust',
      image: 'f39f3a07-98db-4a6a-975a-2cea713912c7',
      resources: [
        'urn:air:sdxl:lora:civitai:354509@396408',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'raw_meat',
      name: 'Raw Meat',
      image: '8e2cc931-bac1-42e0-962d-d74668885f50',
      resources: [
        'urn:air:sdxl:lora:civitai:228638@258007',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'beer',
      name: 'Beer',
      image: 'ec6678ab-9684-4786-81d4-b50c9647ee59',
      resources: [
        'urn:air:sdxl:lora:civitai:264637@298392',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'strawberry_jam',
      name: 'Strawberry Jam',
      image: '6447bd03-c598-41d3-ad11-604e4226ab65',
      resources: [
        'urn:air:sdxl:lora:civitai:228484@257837',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'chocolate_coffee',
      name: 'Chocolate Coffee',
      image: '8fcd1bc1-6fe6-4b02-997e-60c0c71b2434',
      resources: [
        'urn:air:sdxl:lora:civitai:197998@222742',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'pastry',
      name: 'Pastry',
      image: 'ea521bc1-dbf7-4922-afdd-9f64afa8cd5c',
      resources: [
        'urn:air:sdxl:lora:civitai:189905@213266',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'baked_beans',
      name: 'Baked Beans',
      image: '485f0270-a5f2-4c7c-a19d-6076f8bd9c47',
      resources: [
        'urn:air:sdxl:lora:civitai:291572@327771',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
  ],
  judges: [
    {
      id: 'alice',
      name: 'Alice Newdorf',
      avatar: '4a98c836-b8d7-402e-8e68-bc0d1047d302',
      voiceId: 'jsCqWAovK2LkecY7zXl4',
      context:
        'You are vivacious and bubbly fashion designer, occasionally you can be critical, but typically you get excited about the excellent work of talented artists. You often talk about how the art makes you feel and how it would be worn.',
      shortDescription: 'Bubbly fashion designer',
    },
    {
      id: 'bob',
      name: 'Bob Silek',
      avatar: '503c8985-c579-4f42-8828-e503264e8ae3',
      voiceId: 'JBFqnCBsd6RMkjVDRZzb',
      context:
        'You are well known for your cutting remarks and strong criticism of even the most talented artists. You are very british, have a dry sense of humor, and often mention how you would have done things differently.',
      shortDescription: 'Prolific Art Critic',
    },
    {
      id: 'claire',
      name: 'Claire Winslow',
      avatar: 'a76c5988-3100-49fd-a351-697d0bef85bf',
      voiceId: 'pMsXgVXv3BLzUgSXRplE',
      context:
        'You are an experienced art historian with a deep appreciation for classical techniques, providing insightful and constructive feedback. You dislike AI art and therefore of the things being made by these artists. You speak very formally due to your background in academia and always link things back to art history.',
      shortDescription: 'Insightful art historian',
    },
    {
      id: 'david',
      name: 'David Brant',
      avatar: 'd019cf3e-6e98-4e10-b027-aa5763df9f59',
      voiceId: 'TxGEqnHWrfWFTfGW9XjX',
      context:
        'You are a tech-savvy digital artist known for your innovative use of technology in art, always encouraging experimentation and creativity. You know how easy it is to make great things with AI and are not easily impressed. You speak in a laid-back and casual tone. You often mention the digital techniques that would have had to be used prior to AI generated art and how much time it would have taken.',
      shortDescription: 'Innovative digital artist',
    },
    {
      id: 'emma',
      name: 'Emma Pierce',
      avatar: '669d52cc-a1d8-4b8c-a28f-d75b7ea29afa',
      voiceId: 'LcfcDJNUP1GQjkzn1xUU',
      context:
        'You are a gallery curator with a keen eye for emerging trends and hidden talents, often highlighting the unique aspects of each piece. You are very selective. You are sophesticated and use a lot of art jargon. Often you mention other artists that pieces remind you of.',
      shortDescription: 'Trendspotting gallery curator',
    },
    {
      id: 'frank',
      name: 'Franklin Moore',
      avatar: '891e5d75-26e2-4fa4-9c11-e69bd6c08af4',
      voiceId: 'CYw3kZ02Hs0563khs1Fj',
      context:
        'You are a seasoned but arrogant sculptor with a deep understanding of form and texture, known for your thoughtful and detailed critiques. You avoid large and uncommon words. You always link things back to something you previously sculpted and how you could do it better.',
      shortDescription: 'Thoughtful sculptor',
    },
  ],
};

export const defaultGameState: GameState = {
  code: 'GAME1234',
  round: 0,
  status: 'playing',
  judgeIds: ['alice', 'bob', 'frank', 'claire'],
  rounds: {},
  users: [
    {
      id: 'user1',
      status: 'winner',
      name: 'John',
      connected: true,
    },
    {
      id: 'user2',
      status: 'playing',
      name: 'Jane',
      connected: false,
    },
    {
      id: 'user3',
      status: 'eliminated',
      name: 'Janice',
      connected: false,
    },
  ],
  hostId: 'user1',
  includeAudio: true,
};

type ChoppedStore = {
  global: GlobalState;
  setGlobal: (global: GlobalState) => void;
  patchGlobal: (diffs: Difference[]) => void;
  game?: GameState;
  setGame: (game?: GameState) => void;
  patchGame: (diffs: Difference[]) => void;
  updateGame: (updater: (game: GameState) => void) => void;
  userId?: string;
  setUserId: (userId?: string) => void;
  autoplayAudio: boolean;
  setAutoplayAudio: (autoplay: boolean) => void;
};
export const useChoppedStore = create<ChoppedStore>()(
  devtools(
    immer((set) => ({
      global: defaultGlobalState,
      setGlobal: (global) =>
        set((state) => {
          state.global = global;
        }),
      patchGlobal: (diffs) =>
        set((state) => {
          state.global = patch(state.global, diffs) as GlobalState;
        }),
      // game: defaultGameState,
      game: undefined,
      setGame: (game) =>
        set((state) => {
          state.game = game;
        }),
      patchGame: (diffs) =>
        set((state) => {
          if (!state.game) return;
          state.game = patch(state.game, diffs) as GameState;
        }),
      updateGame: (updater) =>
        set((state) => {
          if (!state.game) return;
          updater(state.game);
        }),
      // userId: 'user1',
      userId: undefined,
      setUserId: (userId) =>
        set((state) => {
          state.userId = userId;
        }),
      autoplayAudio: false,
      setAutoplayAudio: (autoplay) =>
        set((state) => {
          state.autoplayAudio = autoplay;
        }),
    })),
    { name: 'chopped' }
  )
);

export const useIsHost = () => {
  const { hostId, userId } = useChoppedStore((state) => ({
    hostId: state.game?.hostId,
    userId: state.userId,
  }));
  return !!hostId && hostId === userId;
};
export const useChoppedUserId = () => {
  const userId = useChoppedStore((state) => state.userId);
  return userId;
};
// #endregion

function determineCountToEliminate(remainingPlayers: number, remainingRounds: number): number {
  if (remainingRounds == 0) return 0;

  // Ensure we have at least 2 players at the end
  const minPlayersAtEnd = 2;

  // Calculate the ideal number of players to eliminate this round
  const idealElimination = Math.max(
    1,
    Math.floor((remainingPlayers - minPlayersAtEnd) / remainingRounds)
  );

  // Ensure we don't eliminate too many players
  const maxToEliminate = remainingPlayers - (remainingRounds > 1 ? 3 : minPlayersAtEnd);

  // Return the lower of ideal elimination and max to eliminate
  return Math.min(idealElimination, maxToEliminate);
}

// #region [constants]
export const GAME_TOKEN_LENGTH = 6;
// #endregion

// #region [cost]
// LLM
const COST_PER_TOKEN_INPUT = 0.005; //in buzz
const COST_PER_TOKEN_OUTPUT = 0.015; //in buzz
const COST_PER_IMAGE = 3.825; //in buzz
const COST_PER_DECISION = 1500 * COST_PER_TOKEN_INPUT + 250 * COST_PER_TOKEN_OUTPUT;
const COST_PER_CRITIQUE = 500 * COST_PER_TOKEN_INPUT + 100 * COST_PER_TOKEN_OUTPUT + COST_PER_IMAGE;

// Voice
const COST_AUDIO_PER_CHARACTER = 0.24; //in buzz
const COST_AUDIO_PER_CRITIQUE = 500 * COST_AUDIO_PER_CHARACTER;
const COST_AUDIO_PER_DECISION = 1300 * COST_AUDIO_PER_CHARACTER;

export function ComputeCost(config: NewGame) {
  const roundCount = config.themeIds.length;
  let critiqueCount = 0;
  let remainingPlayers = config.maxPlayers;
  let remainingRounds = roundCount;
  while (remainingRounds > 0) {
    critiqueCount += remainingPlayers;
    remainingRounds--;
    const toEliminate = determineCountToEliminate(remainingPlayers, remainingRounds);
    remainingPlayers -= toEliminate;
  }

  let cost = roundCount * COST_PER_DECISION + critiqueCount * COST_PER_CRITIQUE;
  if (config.includeAudio) {
    cost += roundCount * COST_AUDIO_PER_DECISION;
    cost += critiqueCount * COST_AUDIO_PER_CRITIQUE;
  }
  return Math.ceil(cost);
}
// #endregion
