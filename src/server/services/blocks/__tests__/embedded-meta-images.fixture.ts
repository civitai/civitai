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

/** {@link pngWithTextChunks} with further `tEXt` chunks appended AFTER `IEND`. */
export async function pngWithChunksAfterEnd(
  before: Record<string, string>,
  after: Record<string, string>
): Promise<Buffer> {
  const png = await pngWithTextChunks(before);
  const trailing = Object.entries(after).map(([key, value]) =>
    pngChunk('tEXt', Buffer.from(`${key}\0${value}`, 'latin1'))
  );
  return Buffer.concat([png, ...trailing]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A real, decodable JPEG whose EXIF `UserComment` holds `comment` (UNICODE, UTF-16BE — the
 * encoding A1111 writes). The APP1 segment is built by hand because sharp here cannot write EXIF.
 */
export async function jpegWithUserComment(comment: string): Promise<Buffer> {
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 128 } },
  })
    .jpeg()
    .toBuffer();

  const utf16be = Buffer.from(comment, 'utf16le').swap16();
  const userComment = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), utf16be]);

  // Big-endian TIFF: header (8) | IFD0 with one entry, ExifIFD pointer (18) | ExifIFD with one
  // entry, UserComment (18) | the comment bytes.
  const ifd0At = 8;
  const exifIfdAt = ifd0At + 2 + 12 + 4;
  const valueAt = exifIfdAt + 2 + 12 + 4;
  const tiff = Buffer.alloc(valueAt + userComment.length);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0At, 4);

  tiff.writeUInt16BE(1, ifd0At);
  tiff.writeUInt16BE(0x8769, ifd0At + 2); // ExifIFDPointer
  tiff.writeUInt16BE(4, ifd0At + 4); // LONG
  tiff.writeUInt32BE(1, ifd0At + 6);
  tiff.writeUInt32BE(exifIfdAt, ifd0At + 10);
  tiff.writeUInt32BE(0, ifd0At + 14);

  tiff.writeUInt16BE(1, exifIfdAt);
  tiff.writeUInt16BE(0x9286, exifIfdAt + 2); // UserComment
  tiff.writeUInt16BE(7, exifIfdAt + 4); // UNDEFINED
  tiff.writeUInt32BE(userComment.length, exifIfdAt + 6);
  tiff.writeUInt32BE(valueAt, exifIfdAt + 10);
  tiff.writeUInt32BE(0, exifIfdAt + 14);
  userComment.copy(tiff, valueAt);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

export const A1111_PARAMETERS =
  'a lighthouse at dusk, oil painting\n' +
  'Negative prompt: blurry\n' +
  'Steps: 24, Sampler: Euler a, CFG scale: 6.5, Seed: 1234567, Size: 8x8';

/** A minimal valid ComfyUI API graph: checkpoint → prompts → KSampler. */
export const COMFY_PROMPT_GRAPH = JSON.stringify({
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a lighthouse at dusk', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 8, height: 8, batch_size: 1 } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 7654321,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
});
