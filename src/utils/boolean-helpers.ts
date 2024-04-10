export function getRandomBool(probability = 1 / 2): boolean {
  // Validate input to ensure it's a valid probability between 0 and 1
  if (probability < 0 || probability > 1) {
    throw new Error('Probability must be between 0 and 1.');
  }

  // Generate a random number between 0 and 1
  const randomNumber = Math.random();

  // Return true if the random number is less than the specified probability
  return randomNumber < probability;
}
