import { spawn, ChildProcess } from 'child_process';
import { logger } from '../src/utils/logger';

interface PortForwardConfig {
  service: string;
  localPort: number;
  remotePort: number;
  description: string;
}

class K8sPortForwarder {
  private namespace = 'metric-watcher';
  private signalsNamespace = 'civitai-signals';
  private processes: ChildProcess[] = [];

  private services: PortForwardConfig[] = [
    {
      service: 'metric-watcher-cluster-kafka-bootstrap',
      localPort: 9092,
      remotePort: 9092,
      description: 'Kafka Bootstrap'
    },
    {
      service: 'kafka-ui',
      localPort: 8080,
      remotePort: 8080,
      description: 'Kafka UI'
    }
  ];

  private signalsService: PortForwardConfig = {
    service: 'civitai-signals-api',
    localPort: 4000,
    remotePort: 80,
    description: 'Signals API'
  };

  async start() {
    console.log('🚀 Starting port-forwarding for K8s services...');
    console.log(`   Namespaces: ${this.namespace}, ${this.signalsNamespace}\n`);

    // Set up graceful shutdown
    this.setupShutdownHandlers();

    // Start all port-forwards in metric-watcher namespace
    for (const config of this.services) {
      await this.startPortForward(config, this.namespace);
      // Small delay between starting each forward
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Start signals service port-forward in civitai-signals namespace
    await this.startPortForward(this.signalsService, this.signalsNamespace);

    console.log('\n✅ Port-forwarding started!\n');
    console.log('📋 Service URLs:');
    console.log('   Kafka Bootstrap: localhost:9092');
    console.log('   Kafka UI: http://localhost:8080');
    console.log('   Signals API: http://localhost:4000\n');
    console.log('⚠️  Press Ctrl+C to stop all port-forwards\n');
  }

  private async startPortForward(config: PortForwardConfig, namespace: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`📡 Forwarding ${config.description} (${config.service}) -> localhost:${config.localPort}`);

      const args = [
        'port-forward',
        `svc/${config.service}`,
        `${config.localPort}:${config.remotePort}`,
        '-n',
        namespace
      ];

      const process = spawn('kubectl', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });

      this.processes.push(process);

      // Handle initial connection
      let connected = false;
      const connectionTimeout = setTimeout(() => {
        if (!connected) {
          console.error(`❌ Failed to establish port-forward for ${config.description}`);
          process.kill();
          reject(new Error(`Port-forward timeout for ${config.service}`));
        }
      }, 10000); // 10 second timeout

      process.stdout?.on('data', (data) => {
        const message = data.toString();
        if (message.includes('Forwarding from')) {
          if (!connected) {
            connected = true;
            clearTimeout(connectionTimeout);
            console.log(`   ✓ Connected: PID ${process.pid}`);
            resolve();
          }
        }
      });

      process.stderr?.on('data', (data) => {
        const error = data.toString().trim();
        // Only log non-connection errors
        if (!error.includes('Handling connection') && !error.includes('Forwarding from')) {
          console.error(`   ⚠️  ${config.description}: ${error}`);
        }
      });

      process.on('error', (err) => {
        console.error(`❌ Failed to start port-forward for ${config.description}:`, err);
        if (!connected) {
          clearTimeout(connectionTimeout);
          reject(err);
        }
      });

      process.on('exit', (code) => {
        if (code !== null && code !== 0 && !connected) {
          console.error(`❌ Port-forward process exited with code ${code} for ${config.description}`);
          clearTimeout(connectionTimeout);
          reject(new Error(`Port-forward failed for ${config.service}`));
        }
      });
    });
  }

  private setupShutdownHandlers() {
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, stopping port-forwards...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Windows specific
    if (process.platform === 'win32') {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl.on('SIGINT', () => shutdown('SIGINT'));
    }
  }

  async stop() {
    console.log('Stopping all port-forward processes...');

    for (const process of this.processes) {
      if (process.pid) {
        try {
          process.kill('SIGTERM');
          console.log(`   Stopped PID ${process.pid}`);
        } catch (err) {
          console.error(`   Failed to stop PID ${process.pid}:`, err);
        }
      }
    }

    this.processes = [];
    console.log('All port-forwards stopped.');
  }
}

// Main execution
async function main() {
  const forwarder = new K8sPortForwarder();

  try {
    await forwarder.start();

    // Keep the process running
    await new Promise(() => {}); // This will run indefinitely until interrupted
  } catch (error) {
    console.error('Failed to start port-forwarding:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}