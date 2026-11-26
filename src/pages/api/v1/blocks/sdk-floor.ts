import type { NextApiRequest, NextApiResponse } from 'next';
import { PLATFORM_SDK_FLOORS } from '@civitai/app-assistant/sdk-floor';

/**
 * GET /api/v1/blocks/sdk-floor — the minimum version of each App Blocks SDK package the platform
 * accepts without comment:
 *
 *   { "packages": [{ "name": "@civitai/sdk", "minimum": "0.33.0" }, …] }
 *
 * `civitai app submit` reads it BEFORE packaging and refuses while the app's lockfile installs a
 * package below its minimum, unless `--allow-outdated-sdk` is passed. A server without this route
 * (404) means "no published minimum": the CLI skips the check rather than refusing.
 *
 * Unauthenticated and static (the same answer for every caller, read from `PLATFORM_SDK_FLOORS`),
 * so the check costs no token, no rate-limit slot and no database read.
 */
export default function sdkFloor(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    packages: PLATFORM_SDK_FLOORS.map(({ name, minimum }) => ({ name, minimum })),
  });
}
