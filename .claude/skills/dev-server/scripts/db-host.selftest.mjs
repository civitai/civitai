// describeDatabaseHost must emit a HOST and never a credential. It exists because an app inherits
// the primary checkout's .env, which may point at production, and the host is the only part of a
// DATABASE_URL that is safe to put in a log line and a status object.
//
// The mutation this guards against is someone "improving" the line to be more informative — logging
// the pathname, the search params, or the whole URL. Any of those carries the password.
import { describeDatabaseHost } from './daemon.mjs';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// The secrets below are invented for this file. They are the assertion, not a fixture: every one
// must be absent from the output.
const SECRETS = ['sup3r-s3cret', 'myuser', 'tok3n-value', 'civitai_prod_db'];

function checkNoLeak(name, url) {
  checks++;
  const out = describeDatabaseHost({ DATABASE_URL: url });
  if (out === null) return;
  const leaked = SECRETS.filter((s) => out.includes(s));
  if (leaked.length) failures.push(`${name}: leaked ${leaked.join(', ')} in ${JSON.stringify(out)}`);
}

check(
  'host and port, credentials dropped',
  describeDatabaseHost({ DATABASE_URL: 'postgres://myuser:sup3r-s3cret@db.example.com:25060/civitai_prod_db' }),
  'db.example.com:25060'
);
check(
  'no port yields the bare host',
  describeDatabaseHost({ DATABASE_URL: 'postgres://myuser:sup3r-s3cret@db.example.com/civitai_prod_db' }),
  'db.example.com'
);
check(
  'an IPv6 literal keeps its brackets',
  describeDatabaseHost({ DATABASE_URL: 'postgres://myuser:sup3r-s3cret@[::1]:5432/civitai_prod_db' }),
  '[::1]:5432'
);
check('a missing DATABASE_URL is null', describeDatabaseHost({}), null);
check('an unparseable value is null, not a guess', describeDatabaseHost({ DATABASE_URL: 'not a url' }), null);
check('an empty value is null', describeDatabaseHost({ DATABASE_URL: '' }), null);

// Two degenerate shapes the correctness lane found. Both must be null, not a truncated string a
// reader would take for a hostname — `postgres:whatever` parses as an opaque path with an empty
// hostname, and `postgres://user:sec@ret` yields `ret`, which is password material.
check('a scheme with no // is null, not an empty string', describeDatabaseHost({ DATABASE_URL: 'postgres:something' }), null);
check('userinfo with no host is null, not the password tail', describeDatabaseHost({ DATABASE_URL: 'postgres://myuser:sup3r-s3cret' }), null);

// libpq keyword DSN — not a URL at all.
check('a libpq keyword DSN is null', describeDatabaseHost({ DATABASE_URL: 'host=db.example.com password=sup3r-s3cret' }), null);

checkNoLeak('password in userinfo', 'postgres://myuser:sup3r-s3cret@db.example.com:25060/civitai_prod_db');
checkNoLeak('secret in the query string', 'postgres://u@h:5432/db?password=sup3r-s3cret&token=tok3n-value');
checkNoLeak('db name in the path', 'postgres://u@h:5432/civitai_prod_db');
checkNoLeak('password containing an @', 'postgres://myuser:sup3r-s3cret@x@db.example.com:25060/db');
checkNoLeak('no scheme', 'myuser:sup3r-s3cret@db.example.com:25060/civitai_prod_db');
checkNoLeak('credentials but no host', 'postgres://myuser:sup3r-s3cret@');

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`db-host selftest: ${checks} checks passed`);
