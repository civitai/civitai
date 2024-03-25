import useSound from 'use-sound';

type GameSound = 'buzz' | 'levelUp' | 'point' | 'undo';
export function useGameSounds() {
  const [playSound] = useSound('/sounds/game.mp3', {
    volume: 0.5,
    sprite: {
      buzz: [0, 89.88662131519274],
      levelUp: [2000, 3122.3129251700675],
      point: [7000, 653.0612244897958],
      undo: [9000, 403.2199546485256],
    },
  });
  const [playPoint] = useSound('/sounds/point.mp3', { volume: 0.5 });

  return (id: GameSound, playbackRate = 1) => {
    if (id === 'point' && playbackRate !== 1) return playPoint({ playbackRate });
    playSound({ id });
  };
}
