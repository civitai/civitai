import type { LayoutServerLoad } from './$types';

// Full content width for every /decisions page: the member table is wide, and the 6xl cap pushed its
// label buttons out of view on an ordinary laptop screen.
export const load: LayoutServerLoad = () => ({ wide: true });
