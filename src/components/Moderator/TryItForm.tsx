import { Badge, Button, Checkbox, Code, Text, TextInput, Textarea } from '@mantine/core';
import { useState } from 'react';
import type { ModeratorEndpointDoc } from '~/server/utils/moderator-endpoint';

// The "try it" form on /moderator/api. Inputs come from the same params the docs render, which come
// from the zod schema that validates the request — so the form cannot offer a field the endpoint does
// not take, or miss one it requires.
//
// These are the REAL endpoints. There is no sandbox: sending on `comment.bulkDelete` deletes comments.
// That is why POST arms before it fires, and why the button says so.

type Param = ModeratorEndpointDoc['params'][number];
type Result = { status: number; body: unknown; ms: number };

/** Arrays and objects are typed as JSON; everything else rides `z.coerce` on the endpoint, so strings
 *  are fine. Unparseable JSON is sent verbatim, letting the endpoint's own 400 explain it rather than
 *  this form inventing a second opinion about the schema. */
function parseValue(param: Param, raw: string): unknown {
  if (param.type === 'array' || param.type === 'object') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function placeholderFor(param: Param): string {
  if (param.type === 'array') return '[1, 2, 3]';
  if (param.type === 'object') return '{ "key": "value" }';
  if (param.type === 'boolean') return 'true';
  return param.type;
}

/** Takes `doc` rather than the catalog entry: an entry whose module failed to load has no doc, and
 *  there is nothing to try. The page decides that, not this component. */
export function TryItForm({ path, doc }: { path: string; doc: ModeratorEndpointDoc }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  // Empty optional fields are OMITTED rather than sent blank: a `''` would reach the schema and fail
  // validation, which reads as the endpoint being broken rather than the field being unset.
  const payload = () => {
    const out: Record<string, unknown> = {};
    for (const param of doc.params) {
      const raw = values[param.name];
      if (raw === undefined || raw === '') continue;
      out[param.name] = parseValue(param, raw);
    }
    return out;
  };

  async function send() {
    setSending(true);
    const started = performance.now();
    try {
      const data = payload();
      const isGet = doc.method === 'GET';
      const url = isGet
        ? `${path}?${new URLSearchParams(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ).toString()}`
        : path;
      const res = await fetch(url, {
        method: doc.method,
        ...(isGet
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // A non-JSON body is usually an HTML error page; showing it raw is more useful than hiding it.
      }
      setResult({ status: res.status, body, ms: Math.round(performance.now() - started) });
    } catch (e) {
      setResult({ status: 0, body: String(e), ms: Math.round(performance.now() - started) });
    } finally {
      setSending(false);
      setArmed(false);
    }
  }

  const live = doc.method !== 'GET';

  return (
    <details className="mt-1 rounded border border-dark-4 p-2">
      <summary className="cursor-pointer text-xs text-gray-500">Try it</summary>

      <div className="mt-2 flex flex-col gap-2">
        {doc.params.map((param) => (
          <div key={param.name}>
            {param.type === 'boolean' ? (
              <Checkbox
                label={
                  <span>
                    <Code>{param.name}</Code>
                    {param.required && <span className="ml-1 text-red-500">*</span>}
                  </span>
                }
                checked={values[param.name] === 'true'}
                onChange={(e) => set(param.name, e.currentTarget.checked ? 'true' : 'false')}
                description={param.description}
              />
            ) : param.type === 'array' || param.type === 'object' ? (
              <Textarea
                label={`${param.name}${param.required ? ' *' : ''}`}
                description={param.description}
                placeholder={placeholderFor(param)}
                autosize
                minRows={2}
                value={values[param.name] ?? ''}
                onChange={(e) => set(param.name, e.currentTarget.value)}
              />
            ) : (
              <TextInput
                label={`${param.name}${param.required ? ' *' : ''}`}
                description={param.description}
                placeholder={placeholderFor(param)}
                value={values[param.name] ?? ''}
                onChange={(e) => set(param.name, e.currentTarget.value)}
              />
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          {!live || armed ? (
            <Button
              size="xs"
              color={live ? 'red' : 'blue'}
              loading={sending}
              onClick={send}
              disabled={sending}
            >
              {live ? 'Yes, send it' : 'Send'}
            </Button>
          ) : (
            <Button size="xs" color="red" variant="outline" onClick={() => setArmed(true)}>
              Send…
            </Button>
          )}

          {live && armed && (
            <Button size="xs" variant="subtle" onClick={() => setArmed(false)}>
              Cancel
            </Button>
          )}

          {live && (
            <Text size="xs" c="red">
              This runs for real — there is no sandbox.
            </Text>
          )}
        </div>

        {result && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Badge color={result.status >= 200 && result.status < 300 ? 'green' : 'red'}>
                {result.status || 'network error'}
              </Badge>
              <Text size="xs" c="dimmed">
                {result.ms}ms
              </Text>
            </div>
            <pre className="max-h-64 overflow-auto rounded bg-dark-8 p-2 text-xs">
              {typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
