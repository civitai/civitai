import { parse, type Node } from 'acorn';

type Literals = { all: Set<string>; prompts: string[] };

/**
 * The fixed text in a user app's source, read off its syntax tree (never run): every string
 * literal and every literal piece of a template, and of those, the ones inside a `prompt` given to
 * `ctx.workflow` or `ctx.ask`. A computed part (a variable, an answer) is in neither. `null` when
 * the source doesn't parse: then nothing about it can be checked, so it is refused.
 */
export function remixSourceLiterals(source: string): Literals | null {
  if (cache.has(source)) return cache.get(source)!;
  const read = readLiterals(source);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(source, read);
  return read;
}

/** By source text: a stored version never changes, and few are live at once. */
const cache = new Map<string, Literals | null>();
const CACHE_MAX = 64;

/**
 * Why an ask can't be shown: text in its prompt or an option label that isn't fixed in the
 * reviewed source. A script could otherwise show the reviewer one text and viewers another.
 */
export function remixAskTextRefusal(
  source: string,
  spec: { prompt: string; options?: readonly { label: string }[] }
) {
  const literals = remixSourceLiterals(source);
  if (!literals) return 'code that cannot be read';
  const shown = [spec.prompt, ...(spec.options ?? []).map((o) => o.label)];
  return shown.every((text) => literals.all.has(text))
    ? undefined
    : 'text that is not fixed in its code';
}

type AnyNode = Node & Record<string, unknown>;
const isNode = (v: unknown): v is AnyNode =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
const childrenOf = (node: AnyNode) =>
  Object.values(node).flatMap((v) => (Array.isArray(v) ? v.filter(isNode) : isNode(v) ? [v] : []));

function piecesOf(node: AnyNode, into: (text: string) => void) {
  if (node.type === 'Literal' && typeof node.value === 'string') into(node.value);
  if (node.type === 'TemplateElement') {
    const cooked = (node.value as { cooked?: string | null }).cooked;
    if (typeof cooked === 'string') into(cooked);
  }
  for (const child of childrenOf(node)) piecesOf(child, into);
}

const keyName = (key: AnyNode) =>
  key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : undefined;

function readLiterals(source: string): Literals | null {
  let program: AnyNode;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as AnyNode;
  } catch {
    return null;
  }
  const all = new Set<string>();
  const prompts: string[] = [];
  piecesOf(program, (text) => all.add(text));
  const visit = (node: AnyNode) => {
    const callee = node.type === 'CallExpression' ? (node.callee as AnyNode) : undefined;
    const method =
      callee?.type === 'MemberExpression' && !callee.computed
        ? keyName(callee.property as AnyNode)
        : undefined;
    const [arg] = (node.arguments as AnyNode[] | undefined) ?? [];
    if ((method === 'workflow' || method === 'ask') && arg?.type === 'ObjectExpression')
      for (const prop of arg.properties as AnyNode[])
        if (prop.type === 'Property' && !prop.computed && keyName(prop.key as AnyNode) === 'prompt')
          piecesOf(prop.value as AnyNode, (text) => text.trim() && prompts.push(text));
    for (const child of childrenOf(node)) visit(child);
  };
  visit(program);
  return { all, prompts };
}
