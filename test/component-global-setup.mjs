import { buildGlobalsCss } from './component-postcss.mjs';

export default async function setup() {
  await buildGlobalsCss();
}
