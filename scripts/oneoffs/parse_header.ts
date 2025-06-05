import * as process from 'node:process';
import { dbRead } from '~/server/db/client';
import { getDownloadFilename } from '~/server/services/file.service';
import { getDownloadUrl } from '~/utils/delivery-worker';

const byteMap: Record<number, string> = {
  16: '14b',
  24: '14b;;i2v',
  32: ';;i2v', // 14b?
  72: '14B;;i2v',
  96: '14b',
  120: '1.3b;720p', // maybe not
  128: '14B;720p;i2v',
  160: '14b;720p',
  168: '1.3b',
  200: '14b',
  240: '1.3b;;t2v',
  // 0
};

// usage: npx cross-env NODE_ENV=development tsx ./scripts/oneoffs/parse_header.ts
async function main() {
  const mvs = await dbRead.modelVersion.findMany({
    where: {
      // id: { in: [1474944, 1525407, 1505137] },
      baseModel: 'Wan Video',
      model: { type: 'LORA' },
      files: { some: { type: 'Model' } },
    },
    select: {
      id: true,
      name: true,
      trainedWords: true,
      model: {
        select: {
          name: true,
          type: true,
        },
      },
      files: {
        where: { type: 'Model' },
        select: {
          url: true,
          name: true,
          overrideName: true,
          type: true,
        },
      },
    },
    // take: 5,
  });

  for (const mv of mvs) {
    // if (!mv) {
    //   console.error('Model version not found');
    // }
    // console.log('----------------------');
    // console.log(mv.id, ':', mv.model.name, '-', mv.name);

    const file = mv.files[0];
    if (!file) {
      console.error('Model version has no files', mv.id);
      continue;
    }

    try {
      const filename = getDownloadFilename({
        model: mv.model,
        modelVersion: mv,
        file: { ...file, overrideName: file.overrideName ?? undefined },
      });

      const { url } = await getDownloadUrl(file.url, filename);
      // console.log(url);

      const response = await fetch(url, {
        headers: {
          Range: 'bytes=0-3',
        },
      });

      if (!response.ok) {
        console.log(`HTTP error! status: ${response.status}`, mv.id);
        continue;
      }

      const buffer = await response.arrayBuffer();
      // const bytes = new Uint8Array(buffer, 0, 1);
      const bytes = new Uint8Array(buffer);
      // TODO check for 14b/1.3b, 720p, etc. in both names
      console.log(
        [
          mv.id,
          `${mv.model.name}:${mv.name}`,
          Array.from(bytes).toString(),
          byteMap[bytes[0]] ?? 'UNK',
        ].join(';')
      );
    } catch (e) {
      console.error(e, mv.id);
    }
  }
}

if (require.main === module) {
  main().then(() => {
    process.exit(0);
  });
}
