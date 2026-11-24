import { register } from '$lib/server/metrics';

/** A counter's current value for one label set; compare before and after, since the registry is per process. */
export async function counterValue(name: string, labels: Record<string, string> = {}) {
  const metric = register.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const { values } = await metric.get();
  const match = values.find((v) =>
    Object.entries(labels).every(([key, value]) => v.labels[key] === value)
  );
  return match?.value ?? 0;
}
