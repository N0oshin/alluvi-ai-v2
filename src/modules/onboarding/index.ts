// Onboarding: the questionnaire and the plan built from it.
//
//   schema.ts            onboarding_responses, plan_generations
//   queries.ts           every database call
//   rules.ts             the questionnaire's rules, pure functions
//   plan-calculator.ts   the plan calculation (document 05), pure functions
//   routes.ts            the HTTP routes
//   jobs.ts              onboarding.generate_plan

export { onboardingRoutes } from './routes.js';
export { onboardingJobs } from './jobs.js';
