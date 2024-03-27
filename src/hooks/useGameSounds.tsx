import useSound from 'use-sound';

type GameSound =
  | 'buzz'
  | 'challengeFail'
  | 'challengePass'
  | 'challenge'
  | 'levelUp'
  | 'point'
  | 'undo';
export function useGameSounds() {
  // return (id: GameSound, playbackRate = 1) => {};

  const [playSound] = useSound('/sounds/game.mp3', {
    volume: 0.5,
    sprite: {
      buzz: [0, 89.88662131519274],
      challengeFail: [2000, 1075.8956916099773],
      challengePass: [5000, 2095.260770975057],
      challenge: [9000, 1705.7142857142865],
      levelUp: [12000, 3122.3129251700675],
      point: [17000, 653.0612244897966],
      undo: [19000, 403.21995464852733],
    },
  });
  const [playPoint] = useSound('/sounds/point.mp3', { volume: 0.5 });

  return (id: GameSound, playbackRate = 1) => {
    if (id === 'point' && playbackRate !== 1) return playPoint({ playbackRate });
    playSound({ id });
  };
}
