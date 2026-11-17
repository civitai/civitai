import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRemixAppRun,
  buildRuntimeRequest,
  runtimeSourceOf,
} from '~/server/services/remix-app.service';
import {
  manifestOf,
  registerRow,
  remixAppBlockRowId,
  remixBlockId,
  type RegisteredRemixApp,
} from '~/server/services/remix-app-registry.service';
import type { RemixAnswer, RemixApp, RemixAsk } from '~/shared/remix-apps/define';
import { dryRunRemixApp } from '~/shared/remix-apps/mock-host';
import { remixAppInputSchema, type RemixAppInput } from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import * as legacy from '~/shared/remix-apps/__tests__/legacy-apps.fixture';

/**
 * The seed must reproduce the system apps exactly as they ran from code: the same menu, and for
 * every answer a viewer can give, the same asks and the same workflows. The oracle is the code
 * as it stood (`legacy-apps.fixture`), never the seed itself.
 */

const LEGACY_MENU = [
  legacy.animeIt,
  legacy.pickOfFour,
  legacy.restyle,
  ...legacy.SYSTEM_REMIX_APPS,
];

const source = { imageId: 7, url: 'https://image.example/source.png', width: 1200, height: 800 };

/** The seed as the registry serves it once the migration has run. */
const SEEDED: RegisteredRemixApp[] = SEED_REMIX_APPS.map((input, order) => {
  const entry = registerRow({
    id: remixAppBlockRowId(input.slug),
    blockId: remixBlockId(input.slug),
    version: '1.0.0',
    manifest: manifestOf(input, 1),
    status: 'remix',
    featuredOrder: order,
  });
  if (!entry) throw new Error(`${input.slug} does not register`);
  return entry;
});

/** A one-shot app's single workflow as a runtime app, so both sides trace the same way. */
function asRuntime(app: (typeof legacy.SYSTEM_REMIX_APPS)[number]): RemixApp {
  return {
    ...app,
    version: 1,
    async run(ctx) {
      const { images } = await ctx.workflow({
        kind: 'image',
        prompt: app.prompt,
        images: [ctx.source],
        aspectRatio: app.params.aspectRatio,
        quantity: app.params.quantity,
      });
      return images;
    },
  };
}

/** Every combination of answers: each option, each pick, and for text a skip, words and padding. */
async function everyTrace(app: RemixApp) {
  const traces: unknown[] = [];
  const TEXTS = ['', 'a red balloon', '  padded words  '];
  const optionsOf = (spec: RemixAsk): RemixAnswer[] =>
    spec.kind === 'choice'
      ? spec.options.map((o) => o.value)
      : spec.kind === 'pick'
      ? spec.images.map((_, i) => i)
      : TEXTS;
  // Answers the first `prefix.length` asks from `prefix`, then branches on the next one.
  async function walk(prefix: RemixAnswer[]) {
    let branches: RemixAnswer[] | undefined;
    let asked = 0;
    const answer = (spec: RemixAsk) => {
      if (asked < prefix.length) return prefix[asked++];
      asked++;
      // Past the branch point the trace is thrown away: any fitting answer does.
      if (branches) return optionsOf(spec)[0];
      branches = optionsOf(spec);
      return branches[0];
    };
    const result = await dryRunRemixApp(app, source, { answer });
    if (!branches) {
      traces.push(result);
      return;
    }
    for (const branch of branches) await walk([...prefix, branch]);
  }
  await walk([]);
  return traces;
}

describe('remix app seed', () => {
  it('every seed row passes the same validation a mod save does', () => {
    for (const input of SEED_REMIX_APPS)
      expect(remixAppInputSchema.safeParse(input).error?.issues).toBeUndefined();
  });

  it('lists the same apps, in the same order, with the same listing and engines', () => {
    expect(
      SEEDED.map(({ slug, name, icon, description, app }) => ({
        slug,
        name,
        icon,
        description,
        engine: app.engine,
      }))
    ).toEqual(
      LEGACY_MENU.map(({ slug, name, icon, description, engine }) => ({
        slug,
        name,
        icon,
        description,
        engine,
      }))
    );
  });

  it('keeps the run version of the apps already on the runtime, so their runs still replay', () => {
    for (const app of [legacy.animeIt, legacy.pickOfFour, legacy.restyle])
      expect(SEEDED.find((s) => s.slug === app.slug)!.app.version).toBe(app.version);
  });

  it.each(LEGACY_MENU.map((app) => [app.slug, app] as const))(
    '%s asks and runs exactly what the code did, for every answer',
    async (slug, old) => {
      const oracle = 'run' in old ? old : asRuntime(old);
      const seeded = SEEDED.find((s) => s.slug === slug)!.app;
      const expected = await everyTrace(oracle);
      // Restyle: 3 texts x 5 styles; Pick of four: 4 picks x 2 finishes; the rest ask nothing.
      expect(expected).toHaveLength({ restyle: 15, 'pick-of-four': 8 }[slug] ?? 1);
      expect(await everyTrace(seeded)).toEqual(expected);
    }
  );

  it.each(legacy.SYSTEM_REMIX_APPS.map((app) => [app.slug, app] as const))(
    '%s submits the same graph input on the runtime as it did one-shot',
    async (slug, old) => {
      const seeded = SEEDED.find((s) => s.slug === slug)!.app;
      const viewer = { isGreen: false, showNsfw: true };
      for (const nsfwLevel of [1, 8]) {
        const image = {
          id: 7,
          url: 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c07',
          type: 'image',
          nsfwLevel,
          width: 1200,
          height: 800,
          ingestion: 'Scanned',
          blockedFor: null,
          minor: false,
          poi: false,
        } as Parameters<typeof runtimeSourceOf>[0];
        // What a real run hands the app as its source.
        const { trace } = await dryRunRemixApp(seeded, runtimeSourceOf(image));
        const [step] = trace;
        if (step?.type !== 'workflow') throw new Error(`${slug} did not start with a workflow`);

        const runtime = buildRuntimeRequest({ app: seeded, image, request: step.request, viewer });
        const oneShot = buildRemixAppRun({ app: old, image, viewer });
        const { submit } = oneShot;
        // The one-shot submit's graph input, as `submitPresetImageGen` builds it.
        expect(runtime.graphInput).toEqual({
          workflow: 'txt2img',
          ecosystem: submit.modelConfig.ecosystem,
          model: { id: submit.modelConfig.versionId },
          aspectRatio: submit.aspectRatio,
          quantity: submit.quantity,
          prompt: submit.prompt,
          images: submit.images,
        });
        expect(runtime.tier).toBe(oneShot.tier);
      }
    }
  );

  it('the migration inserts exactly the seed', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'packages/civitai-db-schema/prisma/migrations/20261225120200_remix_apps_as_rows/migration.sql'
      ),
      'utf8'
    );
    const rows = [
      ...sql.matchAll(
        /\('(ab_rx_[a-z_]+)', '([a-z-]+)', '([0-9.]+)', \$json\$(.*?)\$json\$::jsonb, '(pg|x)', (\d+)\)/g
      ),
    ].map(([, id, blockId, version, manifest, contentRating, order]) => ({
      id,
      blockId,
      version,
      manifest: JSON.parse(manifest),
      contentRating,
      order: Number(order),
    }));
    expect(rows).toEqual(
      SEED_REMIX_APPS.map((input: RemixAppInput, order) => ({
        id: remixAppBlockRowId(input.slug),
        blockId: remixBlockId(input.slug),
        version: '1.0.0',
        manifest: manifestOf(input, 1),
        contentRating: 'x',
        order,
      }))
    );
  });
});
