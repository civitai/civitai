import * as z from 'zod';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { parse as parseStackTrace } from 'stacktrace-parser';
import { SourceMapConsumer } from 'source-map';

import path from 'node:path';
import fs from 'fs';

const schema = z.object({ message: z.string(), stack: z.string(), name: z.string().optional() });

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      const queryInput = schema.parse(JSON.parse(req.body));
      if (isProd) {
        const payload = {
          name: queryInput.name ?? 'application-error',
          type: 'error',
          url: req.headers.referer,
          userId: session?.user?.id,
          browser: req.headers['user-agent'],
          message: queryInput.message,
          // this won't work in dev
          stack: await applySourceMaps(queryInput.stack),
        };
        await logToAxiom(payload);
      }
      return res.status(200).end();
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['POST']
);

// const baseDir = 'tmp/sourceMaps';
async function applySourceMaps(minifiedStackTrace: string) {
  // const date = new Date();
  // date.setUTCHours(0, 0, 0, 0);
  // const datetime = `${date.getTime()}`;
  // const dir = `${baseDir}/${datetime}`;

  const stack = parseStackTrace(minifiedStackTrace);
  const lines = minifiedStackTrace.split('\n');
  const filesToDownload = [...new Set(stack.map((x) => x.file))] as string[];
  const filesToRead = filesToDownload.map((x) => x.split('_next')[1]);

  for (const toDownload of filesToRead) {
    const sourceMapLocation = `${toDownload}.map`;
    // const fileName = sourceMapLocation.split('/').reverse()[0];

    // // download file
    // if (fs.existsSync(`${dir}/${fileName}`)) continue;
    // const res = await fetch(sourceMapLocation);
    // if (!res.body) continue;
    // if (!fs.existsSync(dir)) await mkdir(dir); //Optional if you already have downloads directory
    // const destination = path.resolve(`./${dir}`, fileName);
    // const fileStream = fs.createWriteStream(destination, { flags: 'wx' });
    // await finished(Readable.fromWeb(res.body as any).pipe(fileStream));
    const pathname = path.join(process.cwd(), `./.next/${sourceMapLocation}`);
    const sourceMap = fs.readFileSync(pathname, 'utf-8');

    if (!sourceMap) continue;

    const smc = await new SourceMapConsumer(sourceMap);

    stack.forEach(({ methodName, lineNumber, column, file }) => {
      if (file) {
        const lineIndex = lines.findIndex((x) => x.includes(file));
        if (lineIndex > -1 && !!lineNumber && !!column) {
          const pos = smc.originalPositionFor({ line: lineNumber, column });
          if (pos && pos.line != null) {
            const name = pos.name || methodName;
            lines[lineIndex] = `    at ${name !== '<unknown>' ? name : ''} (${pos.source}:${
              pos.line
            }:${pos.column})`;
          }
        }
      }
    });
  }

  // const directories = fs
  //   .readdirSync(baseDir, { withFileTypes: true })
  //   .filter((x) => x.isDirectory())
  //   .map((x) => x.name);

  // const toRemove = directories.filter((x) => x !== datetime);
  // for (const dir of toRemove) {
  //   fs.rmSync(dir, { recursive: true });
  // }

  return `${lines.join('\n')}`;
}

// const excludeDirs = ['node_modules', 'prisma', 'containers'];
// function readDir(path: string, depth: number): MixedObject {
//   return fs
//     .readdirSync(path, { withFileTypes: true })
//     .filter((x) => x.isDirectory() && !excludeDirs.includes(x.name))
//     .reduce(
//       (acc, { name }) => ({
//         ...acc,
//         [name]: depth > 0 ? readDir(`${path}/${name}`, depth - 1) : undefined,
//       }),
//       {}
//     );
// }
