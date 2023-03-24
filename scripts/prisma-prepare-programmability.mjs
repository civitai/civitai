import {PrismaClient} from '@prisma/client';
import fs from 'fs/promises';

const prisma = new PrismaClient();

async function main() {
  const files = await fs.readdir('./prisma/programmability');

  const operations = [];
  for (const file of files) {
    const content = await fs.readFile(`./prisma/programmability/${file}`, 'utf-8');
    const commands = content
      .split('---')
      .map((x) => x.trim())
      .filter((x) => x);
    for (const i in commands) {
      operations.push({name: `${file}#${i}`, script: commands[i]});
    }
  }

  if (operations.length === 0) {
    console.log('No scripts to apply');
    return;
  }

  try {
    await prisma.$transaction(
      operations.map(({name, script}) => {
        console.log(`Applying ${name}...`);
        console.log(script);
        return prisma.$executeRawUnsafe(script);
      })
    );
    console.log(`Applied ${files.length} scripts`);
  } catch (err) {
    console.error(err);
  }
}

main();
