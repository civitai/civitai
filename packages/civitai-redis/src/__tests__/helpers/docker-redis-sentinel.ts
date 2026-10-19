/**
 * A throwaway Sentinel-managed Redis (one master, one replica, one Sentinel) on a user-defined
 * docker network, for the opt-in integration tests (REDIS_CLUSTER_IT=1). Every container has a
 * fixed address on the network, so a test can take the master away for good — stop and remove
 * it, leaving its address unanswered — which is what a master pod rescheduled under a new
 * address looks like to a client still holding the old one.
 *
 * Linux only: the test process connects to the containers' bridge addresses directly. Names and
 * the /24 are per run (see docker-redis-cluster.ts); `teardown()` removes only this run's own.
 */
import {
  IMAGE,
  createRunNetwork,
  docker,
  removeContainers,
  runScopedName,
} from './docker-redis-cluster';

const PORT = 6379;
const SENTINEL_PORT = 26379;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DockerRedisSentinel {
  /** The master group name the Sentinel monitors. */
  readonly masterName = 'itmaster';
  /** Addresses, set by `start()`. */
  masterIp = '';
  replicaIp = '';
  sentinelIp = '';
  private readonly name: string;
  private readonly master: string;
  private readonly replica: string;
  private readonly sentinel: string;

  /**
   * @param name unique per test file; the per-run suffix is appended to it.
   * @param downAfterMs the Sentinel's `down-after-milliseconds`: how long the master may be gone
   *   before a failover starts. That gap is the window in which the Sentinel still names the old
   *   master, so it decides whether a client rediscovering just after the loss sees a stale one.
   */
  constructor(
    name: string,
    private readonly downAfterMs = 3000,
    /** Redis auth for master and replica (the Sentinel itself takes none). */
    readonly password = 'it-sys-password'
  ) {
    this.name = runScopedName(name);
    this.master = `${this.name}-master`;
    this.replica = `${this.name}-replica`;
    this.sentinel = `${this.name}-sentinel`;
  }

  get sentinelAddress(): string {
    return `${this.sentinelIp}:${SENTINEL_PORT}`;
  }

  get masterUrl(): string {
    return `redis://:${this.password}@${this.masterIp}:${PORT}`;
  }

  async start(): Promise<void> {
    this.teardown(); // only this run's names: a leftover from a crashed run with the same id
    const prefix = createRunNetwork(this.name);
    this.masterIp = `${prefix}.11`;
    this.replicaIp = `${prefix}.12`;
    this.sentinelIp = `${prefix}.21`;
    const common = ['run', '-d', '--network', this.name];
    const noPersistence = ['--appendonly', 'no', '--save', ''];
    const auth = ['--requirepass', this.password, '--masterauth', this.password];
    docker([
      ...common,
      '--name',
      this.master,
      '--ip',
      this.masterIp,
      IMAGE,
      'redis-server',
      ...noPersistence,
      ...auth,
    ]);
    docker([
      ...common,
      '--name',
      this.replica,
      '--ip',
      this.replicaIp,
      IMAGE,
      'redis-server',
      ...noPersistence,
      ...auth,
      '--replicaof',
      this.masterIp,
      String(PORT),
    ]);
    // Sentinel rewrites its config file, so it is written inside the container at start.
    const conf = [
      `port ${SENTINEL_PORT}`,
      `sentinel monitor ${this.masterName} ${this.masterIp} ${PORT} 1`,
      `sentinel down-after-milliseconds ${this.masterName} ${this.downAfterMs}`,
      `sentinel failover-timeout ${this.masterName} 10000`,
      `sentinel parallel-syncs ${this.masterName} 1`,
      `sentinel auth-pass ${this.masterName} ${this.password}`,
    ].join('\\n');
    docker([
      ...common,
      '--name',
      this.sentinel,
      '--ip',
      this.sentinelIp,
      IMAGE,
      'sh',
      '-c',
      `printf '${conf}\\n' > /tmp/sentinel.conf && exec redis-sentinel /tmp/sentinel.conf`,
    ]);
    await this.waitFor(
      () =>
        this.cli(this.replica, ['info', 'replication']).includes('master_link_status:up') &&
        this.currentMaster() === this.masterIp &&
        /num-slaves\s+1/.test(
          this.cli(this.sentinel, [
            '-p',
            String(SENTINEL_PORT),
            'sentinel',
            'master',
            this.masterName,
          ]).replace(/\n/g, ' ')
        ),
      30_000,
      'replica linked and Sentinel monitoring the master'
    );
  }

  /** The master address the Sentinel currently names (empty if it names none). */
  currentMaster(): string {
    const out = this.cli(this.sentinel, [
      '-p',
      String(SENTINEL_PORT),
      'sentinel',
      'get-master-addr-by-name',
      this.masterName,
    ]);
    return out.split('\n')[0]?.trim() ?? '';
  }

  /**
   * Take the master away for good: a graceful stop (it closes its client connections, as an
   * evicted pod does), then remove the container so nothing answers on its address again.
   */
  removeMaster(): void {
    docker(['stop', '-t', '1', this.master]);
    docker(['rm', '-f', this.master], { allowFail: true });
  }

  /**
   * Stop the master, wait `downMs`, start the same container again (same address). Resolves once
   * it answers PING; returns that instant (Date.now()).
   */
  async restartMaster(downMs: number): Promise<number> {
    docker(['stop', '-t', '1', this.master]);
    await sleep(downMs);
    docker(['start', this.master]);
    await this.waitFor(() => this.cli(this.master, ['ping']) === 'PONG', 30_000, 'master back');
    return Date.now();
  }

  /** Stop the master, keeping its container and address (startMaster() brings it back). */
  stopMaster(): void {
    docker(['stop', '-t', '1', this.master]);
  }

  /** Start the master stopped by stopMaster(); resolves once it answers PING (returns Date.now()). */
  async startMaster(): Promise<number> {
    docker(['start', this.master]);
    await this.waitFor(() => this.cli(this.master, ['ping']) === 'PONG', 30_000, 'master back');
    return Date.now();
  }

  /** Resolves once the Sentinel names the replica as master; returns that instant (Date.now()). */
  async waitForFailover(timeoutMs = 30_000): Promise<number> {
    await this.waitFor(() => this.currentMaster() === this.replicaIp, timeoutMs, 'failover');
    return Date.now();
  }

  teardown(): void {
    removeContainers([this.master, this.replica, this.sentinel]);
    docker(['network', 'rm', this.name], { allowFail: true });
  }

  private cli(container: string, args: string[]): string {
    // The Redis nodes need the password; the Sentinel takes none.
    const auth = container === this.sentinel ? [] : ['-e', `REDISCLI_AUTH=${this.password}`];
    return docker(['exec', ...auth, container, 'redis-cli', ...args], { allowFail: true }).trim();
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
