import client from 'prom-client';

// Account counters
export const newUserCounter = new client.Counter({ name: 'new_user', help: 'New user created' });
export const loginCounter = new client.Counter({ name: 'login', help: 'User logged in' });

// Onboarding counters
export const onboardingCompletedCounter = new client.Counter({
  name: 'onboarding_completed',
  help: 'User completed onboarding',
});
export const onboardingErrorCounter = new client.Counter({
  name: 'onboarding_error',
  help: 'User onboarding error',
});

// Content counters
export const leakingContentCounter = new client.Counter({
  name: 'leaking_content',
  help: 'Inappropriate content that was reported in safe feeds',
});

// Vault counters
export const vaultItemProcessedCounter = new client.Counter({
  name: 'vault_item_processed',
  help: 'Vault item processed',
});
export const vaultItemFailedCounter = new client.Counter({
  name: 'vault_item_failed',
  help: 'Vault item failed',
});

// Reward counters
export const rewardGivenCounter = new client.Counter({
  name: 'reward_given',
  help: 'Reward given',
});
export const rewardFailedCounter = new client.Counter({
  name: 'reward_failed',
  help: 'Reward failed',
});
