import { crc32 } from 'node:zlib';
import sharp from 'sharp';

/** A real, decodable PNG carrying the given `tEXt` chunks, inserted before `IEND`. */
export async function pngWithTextChunks(chunks: Record<string, string>): Promise<Buffer> {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 128, b: 0 } },
  })
    .png()
    .toBuffer();
  const iendAt = png.length - 12;
  const text = Object.entries(chunks).map(([key, value]) =>
    pngChunk('tEXt', Buffer.from(`${key}\0${value}`, 'latin1'))
  );
  return Buffer.concat([png.subarray(0, iendAt), ...text, png.subarray(iendAt)]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

export const A1111_PARAMETERS =
  'a lighthouse at dusk, oil painting\n' +
  'Negative prompt: blurry\n' +
  'Steps: 24, Sampler: Euler a, CFG scale: 6.5, Seed: 1234567, Size: 8x8';
