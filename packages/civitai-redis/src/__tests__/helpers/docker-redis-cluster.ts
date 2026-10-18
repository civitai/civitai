/**
 * A throwaway 3-master Redis 7 cluster on a user-defined docker network, for the opt-in
 * integration tests (REDIS_CLUSTER_IT=1). Each node has a fixed address on the network so a test
 * can move one to a NEW address — stop it, re-attach it to the network with another IP, start it
 * with the same nodes.conf — which is what a cluster node looks like after a rolling restart.
 *
 * Linux only: the test process connects to the containers' bridge addresses directly.
 *
 * Concurrent runs are isolated: container and network names carry a per-run suffix
 * (REDIS_CLUSTER_IT_RUN_ID, else the process id), and each run claims its own /24 — docker rejects
 * a network whose subnet overlaps an existing one, so `start()` walks candidate subnets until one
 * is free. `teardown()` only ever removes this run's own containers and network.
 */
import { execFileSync } from 'node:child_process';

/** Image for every integration-test container (REDIS_CLUSTER_IT_IMAGE overrides it). */
export const IMAGE = process.env.REDIS_CLUSTER_IT_IMAGE ?? 'redis:7.4-alpine';
const PORT = 6379;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every docker call is synchronous AND bounded: a sync call blocks the test worker's event loop,
 * so an unbounded one against a slow daemon (seen: `docker rm -f` stalling for minutes) leaves
 * vitest hung after it has printed its results, with no hook timeout able to fire.
 */
const DOCKER_CALL_TIMEOUT_MS = 60_000;

/** Per-run suffix for container and network names. */
const RUN_ID = (process.env.REDIS_CLUSTER_IT_RUN_ID ?? String(process.pid)).replace(
  /[^a-zA-Z0-9_.-]/g,
  '-'
);

/** Candidate /24s: 172.29.0.0/24 .. 172.29.255.0/24, tried from a per-name, per-run offset. */
const SUBNET_CANDIDATES = 256;

export function docker(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DOCKER_CALL_TIMEOUT_MS,
    });
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

/**
 * `docker rm -f` each named container, then re-check and retry: a `docker run` killed by
 * DOCKER_CALL_TIMEOUT_MS can still be created by the daemon after the first `rm -f`, and a
 * timed-out `rm` is swallowed by allowFail.
 */
export function removeContainers(names: readonly string[]): void {
  for (const c of names) docker(['rm', '-f', c], { allowFail: true });
  for (let recheck = 0; recheck < 2; recheck++) {
    const left = names.filter(
      (c) => docker(['ps', '-aq', '--filter', `name=^${c}$`], { allowFail: true }).trim() !== ''
    );
    if (left.length === 0) return;
    for (const c of left) docker(['rm', '-f', c], { allowFail: true });
  }
}

/** `name` with this run's suffix, so concurrent runs never share a container or network name. */
export function runScopedName(name: string): string {
  return `${name}-${RUN_ID}`;
}

/**
 * Create a docker network named `name` on the first free candidate /24; returns its first 3
 * octets. Each run claims its own /24 — docker rejects a network whose subnet overlaps an
 * existing one, so this walks candidate subnets until one is free.
 */
export function createRunNetwork(name: string): string {
  let offset = 0;
  for (const ch of name) offset = (offset * 31 + ch.charCodeAt(0)) % SUBNET_CANDIDATES;
  let lastErr = '';
  for (let k = 0; k < SUBNET_CANDIDATES; k++) {
    const prefix = `172.29.${(offset + k) % SUBNET_CANDIDATES}`;
    try {
      docker(['network', 'create', '--subnet', `${prefix}.0/24`, name]);
      return prefix;
    } catch (err) {
      lastErr = String((err as { stderr?: unknown }).stderr ?? err);
      if (!/overlap/i.test(lastErr)) {
        throw new Error(`docker network create ${name} failed: ${lastErr.trim()}`);
      }
    }
  }
  throw new Error(
    `no free /24 under 172.29.0.0/16 for ${name} (every candidate overlaps an existing ` +
      `docker network). Last error: ${lastErr.trim()}`
  );
}

export class DockerRedisCluster {
  /** Current address of each node, by index (set by `start()`). */
  readonly ips: string[] = [];
  private readonly name: string;
  private readonly containers: string[];
  private subnetPrefix = '';

  /** @param name unique per test file; the per-run suffix is appended to it. */
  constructor(name: string) {
    this.name = runScopedName(name);
    this.containers = [1, 2, 3].map((i) => `${this.name}-${i}`);
  }

  url(i: number): string {
    return `redis://${this.ips[i]}:${PORT}`;
  }

  /** An address on this run's subnet, e.g. `addr(22)`; valid after `start()`. */
  addr(host: number): string {
    if (!this.subnetPrefix) throw new Error('DockerRedisCluster.addr() before start()');
    return `${this.subnetPrefix}.${host}`;
  }

  async start(): Promise<void> {
    this.teardown(); // only this run's names: a leftover from a crashed run with the same id
    this.subnetPrefix = createRunNetwork(this.name);
    this.ips.splice(0, this.ips.length, ...[11, 12, 13].map((h) => this.addr(h)));
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
    removeContainers(this.containers);
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

  /** Raw `redis-cli` on node `i` (e.g. to drive a slot migration); returns trimmed stdout. */
  redisCli(i: number, args: string[]): string {
    return this.cli(i, args);
  }

  /** Cluster node id of node `i`. */
  nodeId(i: number): string {
    return this.cli(i, ['cluster', 'myid']);
  }

  stop(i: number): void {
    docker(['stop', '-t', '1', this.containers[i]]);
  }

  /** Start node `i` again after `stop(i)` (same address); resolves once the cluster is healthy. */
  async restart(i: number): Promise<void> {
    docker(['start', this.containers[i]]);
    await this.waitHealthy();
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
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: DOCKER_CALL_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
