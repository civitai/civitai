import client, { Counter } from 'prom-client';

const PROM_PREFIX = 'civitai_app_';
function registerCounter({ name, help }: { name: string; help: string }) {
  // Do this to deal with HMR in nextjs
  try {
    return new client.Counter({ name: PROM_PREFIX + name, help });
  } catch (e) {
    return client.register.getSingleMetric(name) as Counter<string>;
  }
}

// Account counters
export const newUserCounter = registerCounter({
  name: 'new_user_total',
  help: 'New user created',
});
export const loginCounter = registerCounter({
  name: 'login_total',
  help: 'User logged in',
});

// Onboarding counters
export const onboardingCompletedCounter = registerCounter({
  name: 'onboarding_completed_total',
  help: 'User completed onboarding',
});
export const onboardingErrorCounter = registerCounter({
  name: 'onboarding_error_total',
  help: 'User onboarding error',
});

// Content counters
export const leakingContentCounter = registerCounter({
  name: 'leaking_content_total',
  help: 'Inappropriate content that was reported in safe feeds',
});

// Vault counters
export const vaultItemProcessedCounter = registerCounter({
  name: 'vault_item_processed_total',
  help: 'Vault item processed',
});
export const vaultItemFailedCounter = registerCounter({
  name: 'vault_item_failed_total',
  help: 'Vault item failed',
});

// Reward counters
export const rewardGivenCounter = registerCounter({
  name: 'reward_given_total',
  help: 'Reward given',
});
export const rewardFailedCounter = registerCounter({
  name: 'reward_failed_total',
  help: 'Reward failed',
});
