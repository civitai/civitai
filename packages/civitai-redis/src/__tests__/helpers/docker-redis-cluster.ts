/**
 * A throwaway 3-master Redis 7 cluster on a user-defined docker network, for the opt-in
 * integration tests (REDIS_CLUSTER_IT=1). Each node has a fixed address on the network so a test
 * can move one to a NEW address — stop it, re-attach it to the network with another IP, start it
 * with the same nodes.conf — which is what a cluster node looks like after a rolling restart.
 *
 * Linux only: the test process connects to the containers' bridge addresses directly.
 */
import { execFileSync } from 'node:child_process';

const IMAGE = process.env.REDIS_CLUSTER_IT_IMAGE ?? 'redis:7.4-alpine';
const PORT = 6379;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function docker(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

export class DockerRedisCluster {
  /** Current address of each node, by index. */
  readonly ips: string[];
  private readonly containers: string[];

  /**
   * @param name unique per test file (network + container name prefix)
   * @param subnetPrefix first three octets of a /24 nothing else on the host uses, e.g. '172.29.81'
   */
  constructor(private readonly name: string, private readonly subnetPrefix: string) {
    this.ips = [11, 12, 13].map((h) => `${subnetPrefix}.${h}`);
    this.containers = [1, 2, 3].map((i) => `${name}-${i}`);
  }

  url(i: number): string {
    return `redis://${this.ips[i]}:${PORT}`;
  }

  async start(): Promise<void> {
    this.teardown();
    docker(['network', 'create', '--subnet', `${this.subnetPrefix}.0/24`, this.name]);
    this.containers.forEach((c, i) =>
      docker([
        'run',
        '-d',
        '--name',
        c,
        '--network',
        this.name,
        '--ip',
        this.ips[i],
        IMAGE,
        'redis-server',
        '--cluster-enabled',
        'yes',
        '--cluster-config-file',
        'nodes.conf',
        '--cluster-node-timeout',
        '2000',
        '--appendonly',
        'no',
        '--save',
        '',
      ])
    );
    await this.waitFor(
      () => this.containers.every((_, i) => this.cli(i, ['ping']) === 'PONG'),
      20_000,
      'nodes up'
    );
    this.cli(0, ['--cluster', 'create', ...this.ips.map((ip) => `${ip}:${PORT}`), '--cluster-yes']);
    await this.waitHealthy();
  }

  teardown(): void {
    for (const c of this.containers) docker(['rm', '-f', c], { allowFail: true });
    docker(['network', 'rm', this.name], { allowFail: true });
  }

  /** Index of the master that owns `key`'s slot. */
  ownerOf(key: string): number {
    const slot = Number(this.cli(0, ['cluster', 'keyslot', key]));
    for (const line of this.cli(0, ['cluster', 'nodes']).split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9 || !parts[2].includes('master')) continue;
      const ip = parts[1].split(':')[0];
      for (const range of parts.slice(8)) {
        const [from, to = from] = range.split('-').map(Number);
        if (slot >= from && slot <= to) {
          const idx = this.ips.indexOf(ip);
          if (idx >= 0) return idx;
        }
      }
    }
    throw new Error(`no master owns slot ${slot}`);
  }

  /**
   * Move node `i` to `newIp`: stop it, re-attach it to the network with the new address, wait
   * `downMs`, start it again (same container, so the same nodes.conf and node id). Resolves once another node
   * advertises the new address and the cluster is healthy; returns that instant (Date.now()).
   */
  async move(i: number, newIp: string, downMs = 0): Promise<number> {
    docker(['stop', '-t', '1', this.containers[i]]);
    docker(['network', 'disconnect', this.name, this.containers[i]]);
    docker(['network', 'connect', '--ip', newIp, this.name, this.containers[i]]);
    if (downMs > 0) await sleep(downMs);
    docker(['start', this.containers[i]]);
    this.ips[i] = newIp;
    const other = i === 0 ? 1 : 0;
    await this.waitFor(
      () =>
        this.cli(other, ['cluster', 'nodes'])
          .split('\n')
          .some((l) => l.includes(`${newIp}:${PORT}`) && l.includes('connected')) &&
        this.cli(other, ['cluster', 'info']).includes('cluster_state:ok'),
      30_000,
      `node ${i} advertised at ${newIp}`
    );
    return Date.now();
  }

  stop(i: number): void {
    docker(['stop', '-t', '1', this.containers[i]]);
  }

  private async waitHealthy(): Promise<void> {
    await this.waitFor(
      () =>
        this.containers.every((_, i) =>
          this.cli(i, ['cluster', 'info']).includes('cluster_state:ok')
        ),
      30_000,
      'cluster_state:ok'
    );
  }

  private cli(i: number, args: string[]): string {
    return docker(['exec', this.containers[i], 'redis-cli', ...args], { allowFail: true }).trim();
  }

  private async waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(200);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  }
}

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
