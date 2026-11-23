import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = '.claude/skills/deploy-status/deploy-chain.sh';

// Loads the script's functions without its dispatch line, then stubs its only kubectl wrapper.
function print(fn: string, message: string) {
  const body = `
    source <(sed '/^ACTION=/,$d' "$0")
    k() { case "$*" in *message*) printf '%s\\n' "civitai-dp-prod-pod $MESSAGE" ;; esac; }
    ${fn} run
  `;
  return execFileSync('bash', ['-c', body, script], {
    encoding: 'utf8',
    env: { ...process.env, KUBECONFIG: '/dev/null', MESSAGE: message },
  });
}

describe('deploy-chain script output', () => {
  it.each(['print_canary', 'print_build'])('%s strips URL query strings', (fn) => {
    const out = print(fn, 'Get "http://127.0.0.1:3000/example?first=alpha&second=beta": refused');

    expect(out).toContain('/example?<redacted>": refused');
    expect(out).not.toMatch(/first=alpha|second=beta/);
  });

  it.each(['print_canary', 'print_build'])('%s leaves a message without a query as it is', (fn) => {
    const message = 'Back-off restarting failed container: is it ready? retrying';

    expect(print(fn, message)).toContain(message);
  });
});
