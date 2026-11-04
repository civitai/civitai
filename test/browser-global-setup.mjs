import { prebuildGlobalsCss, prebuildMisses } from './browser-postcss.mjs';

export default async function setup() {
  await prebuildGlobalsCss();
  return () => {
    const missed = prebuildMisses();
    if (missed.length) {
      throw new Error(
        `Prebuilt Tailwind output was not used for ${missed.join(', ')}: Vite transformed it from ` +
          'different text, so its content scan ran mid-run. See test/browser-postcss.mjs.'
      );
    }
  };
}
