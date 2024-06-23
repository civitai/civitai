import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { GameState, GlobalState } from '~/components/Chopped/chopped.shared-types';
import { Difference, patch } from '~/utils/object-helpers';

// #region [state]
const defaultGlobalState: GlobalState = {
  themes: [
    {
      id: 'theme1',
      name: 'Fantasy Landscape',
      description: 'Create a stunning fantasy landscape.',
      judgingCriteria: 'Creativity, Visual appeal, and Adherence to the theme.',
      image: 'https://example.com/fantasy-landscape.jpg',
    },
    {
      id: 'theme2',
      name: 'Cyberpunk City',
      description: 'Design a futuristic cyberpunk city.',
      judgingCriteria: 'Innovation, Detail, and Concept realization.',
      image: 'https://example.com/cyberpunk-city.jpg',
    },
  ],
  judges: [
    {
      id: 'judge1',
      name: 'Alice',
      avatar: 'https://placehold.co/512x512/00ff00/ffffff?text=Alice',
      voiceId: 'elevenlabs-voice-id-1',
      context: 'Alice is a renowned artist with expertise in digital illustrations.',
      shortDescription: 'Renowned artist',
    },
    {
      id: 'judge2',
      name: 'Bob',
      avatar: 'https://placehold.co/512x512/ff0000/ffffff?text=Bob',
      voiceId: 'elevenlabs-voice-id-2',
      context: 'Bob is a veteran game designer known for his creative storytelling.',
      shortDescription: 'Veteran game designer',
    },
  ],
};

const defaultGameState: GameState | undefined = {
  code: 'GAME1234',
  round: 0,
  status: 'setup',
  judges: ['judge1', 'judge2'],
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
      socketId: 'socket1',
    },
    {
      id: 'user2',
      status: 'playing',
      name: 'Jane',
      socketId: 'socket2',
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
  }))
);
// #endregion
