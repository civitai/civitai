import {
  placeholdersOf,
  remixDeclarativeSpecSchema,
  type RemixDeclarativeSpec,
} from '~/shared/remix-apps/row.schema';

export const REMIX_TEMPLATE_VERSION = 1;

const HEADER = (version: number) => `// remix-app-creator template v${version}`;

/** U+2028/2029 are legal in a string literal since ES2019, but not in every parser before it. */
const lit = (value: unknown) =>
  JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/**
 * A declarative spec as a user app's module, run like any other in the sandbox and reviewed
 * through the same submit path. It is written out step by step, never as a loop over the spec:
 * the save audit reads the prompts off the module's syntax (`remixSourceLiterals`), so every ask
 * prompt, step prompt piece, fragment and wrap has to be a literal inside the `prompt` it ends up
 * in. Its behaviour is `compileRemixApp`'s for the same spec.
 *
 * Spec text enters the module only as `JSON.stringify` output: never in a comment, an identifier
 * or a template literal.
 *
 * Throws on a spec that is not a valid declarative one: the module is only ever built from one.
 */
export function remixSpecToSource(spec: RemixDeclarativeSpec, version = REMIX_TEMPLATE_VERSION) {
  const template = TEMPLATES[version];
  if (!template) throw new Error(`No remix app template v${version}`);
  return template(remixDeclarativeSpecSchema.parse(spec));
}

/**
 * The spec a module says it was built from, when the module is exactly what that template builds
 * from it, byte for byte. `null` for anything else: hand-written, edited, or from no known template.
 */
export function remixSourceSpec(
  source: string
): { spec: RemixDeclarativeSpec; version: number } | null {
  const match = /^\/\/ remix-app-creator template v([1-9][0-9]*)\nconst SPEC = (.*);\n/.exec(
    source
  );
  if (!match) return null;
  const version = Number(match[1]);
  let spec: RemixDeclarativeSpec;
  try {
    spec = remixDeclarativeSpecSchema.parse(JSON.parse(match[2]));
    return remixSpecToSource(spec, version) === source ? { spec, version } : null;
  } catch {
    return null;
  }
}

/** Every past version stays: an approved module keeps matching the template it was built with. */
const TEMPLATES: Record<number, (spec: RemixDeclarativeSpec) => string> = { 1: templateV1 };

function templateV1(spec: RemixDeclarativeSpec): string {
  const lines: string[] = [];
  /** What each `{{name}}` in a step prompt becomes, as an expression. */
  const fills = new Map<string, string>();

  spec.asks.forEach((ask, a) => {
    if (ask.kind === 'image')
      // The sandbox can't be handed an image answer yet (`replay.ts`, user apps).
      throw new Error('A generated app cannot ask for an image yet');
    if (ask.kind === 'text') {
      const call = { kind: 'text', prompt: ask.prompt, maxLength: ask.maxLength };
      lines.push(`const t${a} = (await ctx.ask(${askArgs(call, ask.optional)})).trim();`);
      fills.set(
        ask.id,
        ask.wrap
          ? `(t${a} ? ${lit(ask.wrap.before)} + t${a} + ${lit(ask.wrap.after)} : "")`
          : `t${a}`
      );
      return;
    }
    const options = ask.options.map(({ value, label }) => ({ value, label }));
    lines.push(
      `const c${a} = await ctx.ask(${askArgs({ kind: 'choice', prompt: ask.prompt, options })});`,
      // An answer the host let through is always an option; the first stands in otherwise.
      `const o${a} = Math.max(0, ${lit(ask.options.map((o) => o.value))}.indexOf(c${a}));`
    );
    for (const key of Object.keys(ask.options[0].fragments))
      fills.set(key, `[${ask.options.map((o) => lit(o.fragments[key])).join(', ')}][o${a}]`);
  });

  lines.push('let images = [];');
  for (const step of spec.steps) {
    if (step.kind === 'upscale') {
      lines.push(
        `({ images } = await ctx.workflow({ kind: "upscale", image: images[0], scale: ${lit(
          step.scale
        )} }));`
      );
      continue;
    }
    // No `references`: they name image asks, which a generated app refuses above.
    const input = step.input === 'source' ? 'ctx.source' : 'images[0]';
    lines.push(
      `({ images } = await ctx.workflow({ kind: "image", prompt: ${promptExpr(
        step.prompt,
        fills
      )}, images: [${input}], aspectRatio: ${lit(step.aspectRatio)}, quantity: ${lit(
        step.quantity
      )} }));`
    );
  }
  lines.push('return images;');

  return [
    HEADER(1),
    `const SPEC = ${lit(spec)};`,
    'export default defineRemixApp({',
    '  async run(ctx) {',
    ...lines.map((line) => `    ${line}`),
    '  },',
    '});',
    '',
  ].join('\n');
}

/** An ask's argument, with `optional` only when set, as `compileRemixApp` asks it. */
function askArgs(call: Record<string, unknown>, optional?: boolean) {
  const entries = Object.entries(optional ? { ...call, optional: true } : call);
  return `{ ${entries.map(([key, value]) => `${key}: ${lit(value)}`).join(', ')} }`;
}

/** A step prompt as literal pieces and fills joined with `+`, as `compileRemixApp` fills it. */
function promptExpr(prompt: string, fills: Map<string, string>) {
  const names = placeholdersOf(prompt);
  const pieces = prompt.split(/\{\{[^{}]*\}\}/);
  const parts: string[] = [];
  pieces.forEach((piece, i) => {
    if (piece) parts.push(lit(piece));
    if (i < names.length) parts.push(fills.get(names[i]) ?? '""');
  });
  return parts.length ? parts.join(' + ') : '""';
}
