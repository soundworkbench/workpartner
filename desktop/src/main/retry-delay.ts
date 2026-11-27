const steps = [1000, 2000, 4000, 8000, 15000, 30000];
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.round(steps[Math.min(attempt, steps.length - 1)] * (0.8 + random() * 0.4));
