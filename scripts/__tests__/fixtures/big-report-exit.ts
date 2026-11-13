// Spawned (under tsx) by the M3 smoke test: prints a report much larger than a pipe
// buffer through the gold-set runner's REAL `runAsScript` — real drain, real
// `process.exit` — and nothing else. The parent reads it through a pipe and checks every
// byte arrived. Size and terminator come from the parent so the check is not circular.
import { runAsScript } from '../../eval-resource-intent-goldset';

const bytes = Number(process.env.M3_BIG_REPORT_BYTES ?? '0');
const end = process.env.M3_BIG_REPORT_END ?? '';

void runAsScript(async () => {
  console.log('x'.repeat(bytes) + end);
});
