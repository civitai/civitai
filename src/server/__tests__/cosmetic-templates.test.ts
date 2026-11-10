import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  cosmeticDimensionsPass,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

const TEMPLATES_DIR = join(process.cwd(), 'public/images/cosmetic-templates');

const readTemplate = async (file: string) => {
  const buf = readFileSync(join(TEMPLATES_DIR, file));
  const { width = 0, height = 0 } = await sharp(buf).metadata();
  const { isOpaque } = await sharp(buf).stats();
  return { width, height, hasTransparentPixels: !isOpaque };
};

describe('shipped Creator Shop templates', () => {
  it.each([
    ['badge.png', CosmeticType.Badge],
    ['avatar-frame.png', CosmeticType.ProfileDecoration],
    ['profile-background.png', CosmeticType.ProfileBackground],
  ])('%s passes its own submit-side dimension rule', async (file, type) => {
    const req = cosmeticImageRequirements(type);
    const { width, height, hasTransparentPixels } = await readTemplate(file);
    expect({ width, height, pass: cosmeticDimensionsPass(req, width, height) }).toMatchObject({
      pass: true,
    });
    if (req.requireTransparency)
      expect({ file, hasTransparentPixels }).toEqual({ file, hasTransparentPixels: true });
  });
});
