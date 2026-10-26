/**
 * attach-url / detach-url: give a version a model file that points at an object another version's
 * file already stores, so a copy of a model needs no re-upload. See SKILL.md → "Reusing a file".
 *
 * Kept out of model.mjs so it can be tested with the API and fetch injected.
 */

const PROBE_BYTES = 64 * 1024;
const TARGET_ATTEMPTS = 4;
const RETRY_MS = 5000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A file row as `modelFile.getByVersionId` returns it, or a reason it can't be used. */
async function findFile(call, versionId, fileId) {
  const record = await call('modelFile.getByVersionId', { id: versionId }, 'GET');
  const files = record?.files ?? [];
  const file = files.find((f) => f.id === fileId);
  return { file, files };
}

// A url names its object by key, which is the path for a virtual-host url and the path minus the
// bucket segment for a path-style one. Two urls name the same key when either reading matches.
function keyReadings(url) {
  const segments = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
  return [segments.join('/'), segments.slice(1).join('/')].filter(Boolean);
}

export function sameObjectKey(a, b) {
  try {
    const keys = new Set(keyReadings(a));
    return keyReadings(b).some((k) => keys.has(k));
  } catch {
    return false;
  }
}

/**
 * Reads the first bytes of a file through the site's download route, which resolves the file's
 * storage location by file id, so a location that does not resolve fails here and not in a job.
 */
export async function probeDownload({ apiUrl, apiKey, fetchFn, versionId, fileId }) {
  let res;
  try {
    res = await fetchFn(`${apiUrl}/api/download/models/${versionId}?fileId=${fileId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Range: `bytes=0-${PROBE_BYTES - 1}` },
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  if (!res.ok) {
    await res.body?.cancel?.();
    return { ok: false, status: res.status };
  }

  // A server that ignores Range answers 200 with the whole file, so read only what is compared.
  const chunks = [];
  let length = 0;
  const reader = res.body.getReader();
  while (length < PROBE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  await reader.cancel().catch(() => undefined);

  const bytes = Buffer.concat(chunks).subarray(0, PROBE_BYTES);
  const range = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  const total = range ? Number(range[1]) : Number(res.headers.get('content-length')) || null;
  return { ok: true, status: res.status, total, bytes };
}

function describeProbe(p) {
  if (!p.ok) return `FAILED (HTTP ${p.status}${p.error ? `: ${p.error}` : ''})`;
  return `ok (HTTP ${p.status}, ${p.total ?? '?'} bytes, read ${p.bytes.length})`;
}

function sameBytes(a, b) {
  return a.ok && b.ok && a.total === b.total && a.bytes.length > 0 && a.bytes.equals(b.bytes);
}

/**
 * @returns {Promise<boolean>} whether the version ends up with a file that downloads the same
 * bytes as the source. Prints what it does; never throws for an expected refusal.
 */
export async function attachUrl(opts, deps) {
  const { fromFile, fromVersion, version, url: override, writable } = opts;
  const { call, fetchFn, apiUrl, apiKey, log, sleep = defaultSleep } = deps;
  const probe = (versionId, fileId) =>
    probeDownload({ apiUrl, apiKey, fetchFn, versionId, fileId });

  const { file: source } = await findFile(call, fromVersion, fromFile);
  if (!source) {
    log(`No file ${fromFile} on version ${fromVersion}.`);
    return false;
  }
  if (!source.url) {
    log('The source file came back without its url. The API key must belong to a moderator.');
    return false;
  }
  if (override && !sameObjectKey(source.url, override)) {
    log(
      `--url names a different object than the source file:\n  source ${source.url}\n  --url  ${override}`
    );
    return false;
  }
  const url = override ?? source.url;

  const { files: existing } = await findFile(call, version, -1);
  const already = existing.find((f) => f.url === url);

  const payload = {
    modelVersionId: version,
    name: source.name,
    ...(source.overrideName ? { overrideName: source.overrideName } : {}),
    url,
    sizeKB: source.sizeKB,
    type: source.type,
    ...(source.visibility ? { visibility: source.visibility } : {}),
    ...(source.metadata ? { metadata: source.metadata } : {}),
  };

  log(`Source: file ${source.id} on version ${fromVersion} (${source.type}, ${source.sizeKB} KB)`);
  log(`  url: ${source.url}`);
  const sourceProbe = await probe(fromVersion, source.id);
  log(`  download: ${describeProbe(sourceProbe)}`);
  if (!sourceProbe.ok) {
    log('The source does not download, so a copy of its url would not either. Stopping.');
    return false;
  }

  if (already) {
    log(`Version ${version} already has file ${already.id} with this url. Nothing to create.`);
  } else if (!writable) {
    log(`[dry run] modelFile.create → ${apiUrl}`);
    log(JSON.stringify(payload, null, 2));
    log('Re-run with --writable to apply.');
    return true;
  }

  let targetId = already?.id;
  if (!already) {
    const created = await call('modelFile.create', payload);
    targetId = created.id;
    log(`Created file ${targetId} on version ${version}.`);
  }

  // The download route finds the file on a read replica, which can lag a just-created row.
  let targetProbe;
  for (let attempt = 1; attempt <= TARGET_ATTEMPTS; attempt++) {
    targetProbe = await probe(version, targetId);
    if (targetProbe.ok || attempt === TARGET_ATTEMPTS) break;
    log(`  download: ${describeProbe(targetProbe)}, retrying`);
    await sleep(RETRY_MS);
  }
  log(`  download: ${describeProbe(targetProbe)}`);
  if (sameBytes(sourceProbe, targetProbe)) {
    log('VERIFIED: the new file downloads the same bytes as the source.');
    return true;
  }
  log('NOT VERIFIED: the new file does not download the same bytes as the source.');
  if (url !== source.url) {
    log('Its url differs from the source url, so detach-url will refuse it. Remove it by hand.');
    return false;
  }
  log('Remove it (the source keeps the stored object) with:');
  log(
    `  node .claude/skills/official-model-admin/model.mjs detach-url --file ${targetId} --version ${version} ` +
      `--from-file ${source.id} --from-version ${fromVersion} --writable`
  );
  return false;
}

/**
 * Deletes a file that attach-url made. Allowed only while the source row still holds the same
 * url, because then the delete's own cleanup sees the object in use and leaves it stored.
 */
export async function detachUrl(opts, deps) {
  const { file: fileId, version, fromFile, fromVersion, writable } = opts;
  const { call, log } = deps;

  const { file: target } = await findFile(call, version, fileId);
  const { file: source } = await findFile(call, fromVersion, fromFile);
  if (!target || !source) {
    log(
      `Not found: ${
        !target
          ? `file ${fileId} on version ${version}`
          : `file ${fromFile} on version ${fromVersion}`
      }.`
    );
    return false;
  }
  if (!target.url || target.url !== source.url) {
    log(
      'The two files do not share a url, so deleting this one could delete the stored object. Refusing.'
    );
    return false;
  }
  if (!writable) {
    log(
      `[dry run] modelFile.delete { id: ${fileId} } (shares its url with file ${fromFile}, which keeps the object)`
    );
    return true;
  }
  await call('modelFile.delete', { id: fileId });
  log(
    `Deleted file ${fileId} from version ${version}. File ${fromFile} and its object are untouched.`
  );
  return true;
}
