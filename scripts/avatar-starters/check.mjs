// Requests every avatar starter image on the CDN and reports any that fail.
// Usage: node scripts/avatar-starters/check.mjs <image-host>   (the NEXT_PUBLIC_IMAGE_LOCATION value)
import fs from 'node:fs';

const host = process.argv[2]?.replace(/\/$/, '');
if (!host) throw new Error('usage: node scripts/avatar-starters/check.mjs <image-host>');
const manifest = JSON.parse(
  fs.readFileSync(new URL('../../src/shared/constants/avatar-starters.json', import.meta.url), 'utf8')
);

const urls = Object.entries(manifest).flatMap(([style, starters]) =>
  starters.flatMap((s) =>
    ['colour', 'grey'].map((variant) => ({ label: `${style}/${s.character}/${variant}`, url: `${host}/${s[variant].url}/original=true/${s.character}.jpeg` }))
  )
);
const failed = [];
for (let i = 0; i < urls.length; i += 16) {
  await Promise.all(
    urls.slice(i, i + 16).map(async ({ label, url }) => {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (!res?.ok) failed.push(`${label}: ${res ? res.status : 'no response'}`);
    })
  );
}
console.log(`${urls.length - failed.length} of ${urls.length} starter images reachable`);
if (failed.length) {
  console.log(failed.join('\n'));
  process.exit(1);
}
