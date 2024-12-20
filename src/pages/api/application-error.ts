import { z } from 'zod';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import stackTraceParser from 'stacktrace-parser';
import { SourceMapConsumer } from 'source-map';

import path from 'node:path';
import fs from 'fs';
import { mkdir } from 'fs/promises';
import { finished } from 'stream/promises';
import { Readable } from 'stream';

const schema = z.object({ message: z.string(), stack: z.string() });

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      const queryInput = schema.parse(JSON.parse(req.body));
      if (isProd) {
        const payload = {
          name: 'application-error',
          type: 'error',
          url: req.headers.referer,
          userId: session?.user?.id,
          browser: req.headers['user-agent'],
          message: queryInput.message,
          // don't know if this would even work in dev
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

async function applySourceMaps(minifiedStackTrace: string) {
  const dir = `sourceMaps/${Date.now}`;

  const stack = stackTraceParser.parse(minifiedStackTrace);
  const lines = minifiedStackTrace.split('\n');
  const filesToDownload = [...new Set(stack.map((x) => x.file))];

  for (const toDownload of filesToDownload) {
    const sourceMapLocation = `${toDownload}.map`;
    const fileName = sourceMapLocation.split('/').reverse()[0];
    try {
      // download file
      if (fs.existsSync(`${dir}/${fileName}`)) return;
      const res = await fetch(sourceMapLocation);
      if (!res.body) return;
      if (!fs.existsSync(dir)) await mkdir(dir); //Optional if you already have downloads directory
      const destination = path.resolve(`./${dir}`, fileName);
      const fileStream = fs.createWriteStream(destination, { flags: 'wx' });
      await finished(Readable.fromWeb(res.body as any).pipe(fileStream));

      const sourceMap = JSON.parse(
        await fs.readFileSync(`${process.cwd()}/${dir}/${fileName}`, 'utf-8')
      );
      // WTF? promise?
      const smc = await new SourceMapConsumer(sourceMap);

      stack.forEach(({ methodName, lineNumber, column, file }) => {
        try {
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
        } catch (err) {
          console.log(`    at FAILED_TO_PARSE_LINE`);
        }
      });
    } catch (e) {}
  }
  fs.rmSync(dir, { recursive: true });

  return `${lines.join('\n')}`;
}
