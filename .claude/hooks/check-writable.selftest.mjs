/**
 * `node .claude/hooks/check-writable.selftest.mjs`
 *
 * A guard people route around protects nothing, so the false-positive rows matter as much as the
 * blocked ones: a request that already carries a bound, a request to production, and a command that
 * only mentions a port must all run untouched.
 */

import { unboundedDevRequest } from './check-writable.mjs';

let failures = 0;
const check = (name, cmd, expectBlocked) => {
  const blocked = unboundedDevRequest(cmd).length > 0;
  const pass = blocked === expectBlocked;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  blocked=${blocked} want=${expectBlocked}`);
};

check('bare curl at 3000', 'curl http://localhost:3000/home', true);
check('port 3010 (findAvailablePort scans 100 ports)', 'curl http://localhost:3010/home', true);
check('command substitution', 'X=$(curl http://localhost:3000/home)', true);
check('backticks', 'X=`curl http://localhost:3000/home`', true);
check('0.0.0.0', 'curl http://0.0.0.0:3000/x', true);

// False positives. Every row below was a hard BLOCK before this was narrowed to command position;
// a guard that stops prose, comments and production traffic is one people route around.
check('prose mentioning it', 'echo "do not curl http://localhost:3000/home"', false);
check('shell comment', '# curl http://localhost:3000/home is what NOT to do', false);
check('writing the incident down', 'printf "%s" " curl http://localhost:3000/x" >> notes.md', false);
check('production URL with a dev port in a query param', 'curl "https://civitai.com/cb?redirect=http://localhost:3000/x"', false);
check('curl -m5 (no space)', 'curl -m5 http://localhost:3000/home', false);
check('curl -sm 5 (bundled shorts)', 'curl -sm 5 http://localhost:3000/home', false);
check('wget -T 5', 'wget -T 5 http://localhost:3000/x', false);
// -T is curl's --upload-file and -m is wget's --mirror: neither bounds anything.
check('curl -T is upload-file, not a bound', 'curl -T 5.json http://localhost:3000/upload', true);
check('wget -m is mirror, not a bound', 'wget -m 3 http://localhost:3000/', true);
check('curl 127.0.0.1', 'curl -s http://127.0.0.1:3001/models', true);
check('chained curls', 'curl localhost:3000/a && curl localhost:3000/b && node x.mjs', true);
check('vite app port', 'curl http://localhost:5174/', true);
check('daemon port', 'curl http://localhost:9444/sessions', true);
check('powershell iwr', 'Invoke-WebRequest http://localhost:3000/home', true);

check('curl with --max-time', 'curl --max-time 30 http://localhost:3000/home', false);
check('curl with -m', 'curl -m 5 http://localhost:3000/home', false);
check('curl with --connect-timeout', 'curl --connect-timeout 3 http://localhost:3000/x', false);
check('iwr with -TimeoutSec', 'Invoke-WebRequest -TimeoutSec 10 http://localhost:3000/x', false);
check('curl to prod', 'curl https://civitai.com/api/v1/models', false);
check('curl to other local port', 'curl http://localhost:8080/thing', false);
check('no curl at all', 'node .claude/skills/dev-server/cli.mjs probe /home', false);
check('mentions the port only', 'echo "the dev server is on localhost:3000"', false);
check('probe command itself', 'node cli.mjs probe /home --port 3000', false);

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
