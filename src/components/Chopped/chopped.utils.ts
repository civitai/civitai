import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { GameState, GlobalState } from '~/components/Chopped/chopped.shared-types';
import { Difference, patch } from '~/utils/object-helpers';

// #region [state]
const defaultGlobalState: GlobalState = {
  themes: [
    {
      id: 'lemon',
      name: 'Lemon',
      image: 'https://placehold.co/512x512?text=Lemon',
      resources: [
        'urn:air:sdxl:lora:civitai:303929@341209',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'egg',
      name: 'Egg',
      image: 'https://placehold.co/512x512?text=Egg',
      resources: [
        'urn:air:sdxl:lora:civitai:255828@288399',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'pancake',
      name: 'Pancake',
      image: 'https://placehold.co/512x512?text=Pancake',
      resources: [
        'urn:air:sdxl:lora:civitai:302772@339987',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'watermelon',
      name: 'Watermelon',
      image: 'https://placehold.co/512x512?text=Watermelon',
      resources: [
        'urn:air:sdxl:lora:civitai:507962@564577',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'roasted',
      name: 'Roasted',
      image: 'https://placehold.co/512x512?text=Roasted',
      resources: [
        'urn:air:sdxl:lora:civitai:497710@553293',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'salad',
      name: 'Salad',
      image: 'https://placehold.co/512x512?text=Salad',
      resources: [
        'urn:air:sdxl:lora:civitai:484650@538994',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'grilled_steak',
      name: 'Grilled Steak',
      image: 'https://placehold.co/512x512?text=Grilled+Steak',
      resources: [
        'urn:air:sdxl:lora:civitai:447029@497801',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'bread_crust',
      name: 'Bread Crust',
      image: 'https://placehold.co/512x512?text=Bread+Crust',
      resources: [
        'urn:air:sdxl:lora:civitai:354509@396408',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'raw_meat',
      name: 'Raw Meat',
      image: 'https://placehold.co/512x512?text=Raw+Meat',
      resources: [
        'urn:air:sdxl:lora:civitai:228638@258007',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'beer',
      name: 'Beer',
      image: 'https://placehold.co/512x512?text=Beer',
      resources: [
        'urn:air:sdxl:lora:civitai:264637@298392',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'strawberry_jam',
      name: 'Strawberry Jam',
      image: 'https://placehold.co/512x512?text=Strawberry+Jam',
      resources: [
        'urn:air:sdxl:lora:civitai:228484@257837',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'chocolate_coffee',
      name: 'Chocolate Coffee',
      image: 'https://placehold.co/512x512?text=Chocolate+Coffee',
      resources: [
        'urn:air:sdxl:lora:civitai:197998@222742',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'pastry',
      name: 'Pastry',
      image: 'https://placehold.co/512x512?text=Pastry',
      resources: [
        'urn:air:sdxl:lora:civitai:189905@213266',
        'urn:air:sdxl:checkpoint:civitai:133005@348913',
      ],
    },
    {
      id: 'baked_beans',
      name: 'Baked Beans',
      image: 'https://placehold.co/512x512?text=Baked+Beans',
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
      avatar: 'https://placehold.co/512x512/00ff00/ffffff?text=Alice',
      voiceId: 'jsCqWAovK2LkecY7zXl4',
      context:
        'You are vivacious and bubbly fashion designer, occasionally you can be critical, but typically you get excited about the excellent work of talented artists. You often talk about how the art makes you feel and how it would be worn.',
      shortDescription: 'Bubbly fashion designer',
    },
    {
      id: 'bob',
      name: 'Bob Silek',
      avatar: 'https://placehold.co/512x512/ff0000/ffffff?text=Bob',
      voiceId: 'JBFqnCBsd6RMkjVDRZzb',
      context:
        'You are well known for your cutting remarks and strong criticism of even the most talented artists. You are very british, have a dry sense of humor, and often mention how you would have done things differently.',
      shortDescription: 'Prolific Art Critic',
    },
    {
      id: 'claire',
      name: 'Claire Winslow',
      avatar: 'https://placehold.co/512x512/0000ff/ffffff?text=Claire',
      voiceId: 'pMsXgVXv3BLzUgSXRplE',
      context:
        'You are an experienced art historian with a deep appreciation for classical techniques, providing insightful and constructive feedback. You dislike AI art and therefore of the things being made by these artists. You speak very formally due to your background in academia and always link things back to art history.',
      shortDescription: 'Insightful art historian',
    },
    {
      id: 'david',
      name: 'David Brant',
      avatar: 'https://placehold.co/512x512/ffff00/000000?text=David',
      voiceId: 'TxGEqnHWrfWFTfGW9XjX',
      context:
        'You are a tech-savvy digital artist known for your innovative use of technology in art, always encouraging experimentation and creativity. You know how easy it is to make great things with AI and are not easily impressed. You speak in a laid-back and casual tone. You often mention the digital techniques that would have had to be used prior to AI generated art and how much time it would have taken.',
      shortDescription: 'Innovative digital artist',
    },
    {
      id: 'emma',
      name: 'Emma Pierce',
      avatar: 'https://placehold.co/512x512/ff00ff/ffffff?text=Emma',
      voiceId: 'LcfcDJNUP1GQjkzn1xUU',
      context:
        'You are a gallery curator with a keen eye for emerging trends and hidden talents, often highlighting the unique aspects of each piece. You are very selective. You are sophesticated and use a lot of art jargon. Often you mention other artists that pieces remind you of.',
      shortDescription: 'Trendspotting gallery curator',
    },
    {
      id: 'frank',
      name: 'Franklin Moore',
      avatar: 'https://placehold.co/512x512/00ffff/000000?text=Frank',
      voiceId: 'CYw3kZ02Hs0563khs1Fj',
      context:
        'You are a seasoned but arrogant sculptor with a deep understanding of form and texture, known for your thoughtful and detailed critiques. You avoid large and uncommon words. You always link things back to something you previously sculpted and how you could do it better.',
      shortDescription: 'Thoughtful sculptor',
    },
  ],
};

const defaultGameState: GameState | undefined = {
  code: 'GAME1234',
  round: 0,
  status: 'setup',
  judgeIds: ['alice', 'bob'],
  rounds: [
    {
      status: 'pending',
      themeId: 'theme1',
      duration: 300, // 5 minutes
      submissions: [],
      decisionType: 'elimination',
      decisionsNeeded: 1,
      decisionUsers: [],
    },
  ],
  users: [
    {
      id: 'user1',
      status: 'playing',
      name: 'John',
    },
    {
      id: 'user2',
      status: 'playing',
      name: 'Jane',
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
  setGame: (game: GameState) => void;
  patchGame: (diffs: Difference[]) => void;
  userId?: string;
  setUserId: (userId: string) => void;
};
export const useChoppedStore = create<ChoppedStore>()(
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
    game: defaultGameState,
    setGame: (game) =>
      set((state) => {
        state.game = game;
      }),
    patchGame: (diffs) =>
      set((state) => {
        if (!state.game) return;
        state.game = patch(state.game, diffs) as GameState;
      }),
    userId: undefined,
    setUserId: (userId) =>
      set((state) => {
        state.userId = userId;
      }),
  }))
);
// #endregion
