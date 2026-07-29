import {PrismaClient} from '@prisma/client';
import fs from 'fs/promises';

const prisma = new PrismaClient();

const dir = './packages/civitai-db-schema/prisma/programmability';

// Everything is applied in a single transaction, so an object must be created
// before any other object that references it. iif() (IIF.sql) is used
// throughout views.sql, and the other helper functions may be referenced by
// later views/triggers, so force the standalone helper functions to the front
// and views.sql (which depends on iif()) to the back. Filesystem readdir order
// is not guaranteed across platforms, so make the rest deterministic too.
const applyFirst = ['IIF.sql', 'months_between.sql', 'is_new_user.sql'];
const applyLast = ['views.sql'];

function orderFiles(files) {
  const middle = files
    .filter((file) => !applyFirst.includes(file) && !applyLast.includes(file))
    .sort();
  return [
    ...applyFirst.filter((file) => files.includes(file)),
    ...middle,
    ...applyLast.filter((file) => files.includes(file)),
  ];
}

async function main() {
  const files = orderFiles(await fs.readdir(dir));

  const operations = [];
  for (const file of files) {
    const content = await fs.readFile(`${dir}/${file}`, 'utf-8');
    const commands = content
      .split('---')
      .map((x) => x.trim())
      .filter((x) => x);
    commands.forEach((script, i) => operations.push({name: `${file}#${i}`, script}));
  }

  if (operations.length === 0) {
    console.log('No scripts to apply');
    return;
  }

  await prisma.$transaction(
    operations.map(({name, script}) => {
      console.log(`Applying ${name}...`);
      return prisma.$executeRawUnsafe(script);
    })
  );
  console.log(`Applied ${operations.length} statements from ${files.length} files`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
