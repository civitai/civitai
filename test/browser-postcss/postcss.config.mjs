// Vite loads this only when a browser project transforms CSS, so the root vitest config (which
// every suite loads) does not pull in Tailwind and the app's PostCSS.
import { browserPostcss } from '../browser-postcss.mjs';

export default browserPostcss;
