import { pgEnum } from 'drizzle-orm/pg-core';

// Identity
export const userStatusEnum = pgEnum('user_status', [
  'active',
  'suspended',
  'pending_deletion',
  'deleted',
]);
export const authProviderEnum = pgEnum('auth_provider', ['apple', 'google', 'email']);
export const consentTypeEnum = pgEnum('consent_type', ['terms_and_privacy', 'marketing']);
export const platformEnum = pgEnum('platform', ['ios', 'android']);
// A phone permission as the app last reported it: push notifications on both
// platforms, exact alarms on Android
export const permissionStateEnum = pgEnum('permission_state', [
  'granted',
  'denied',
  'not_determined',
]);

export const magicIntentEnum = pgEnum('magic_intent', ['sign_in', 'sign_up']);

// Profile
export const avatarKindEnum = pgEnum('avatar_kind', ['initials', 'uploaded']);
export const appearanceEnum = pgEnum('appearance', ['automatic', 'light', 'dark']);
export const sexEnum = pgEnum('sex', ['male', 'female', 'other']);

// Onboarding and goals
export const workoutFrequencyEnum = pgEnum('workout_frequency', ['0_2', '3_5', '6_plus']);
export const weightGoalDirectionEnum = pgEnum('weight_goal_direction', [
  'lose',
  'maintain',
  'gain',
]);
export const obstacleEnum = pgEnum('obstacle', [
  'consistency',
  'eating_habits',
  'support',
  'busy_schedule',
  'meal_inspiration',
]);
export const motivationEnum = pgEnum('motivation', [
  'eat_healthier',
  'energy_mood',
  'stay_motivated',
  'body_confidence',
]);
// Screen 95, "Where did you hear about us?".
export const acquisitionSourceEnum = pgEnum('acquisition_source', [
  'facebook',
  'tiktok',
  'friend_or_family',
  'instagram',
  'youtube',
  'app_store',
  'tv',
]);
// The five lines that tick off on screens 113 to 115 while a plan is built, in
// the order they tick (document 01 section 6.2).
export const planStepEnum = pgEnum('plan_step', [
  'calories',
  'carbs',
  'protein',
  'fats',
  'health_score',
]);
export const activityLevelEnum = pgEnum('activity_level', [
  'sedentary',
  'light',
  'moderate',
  'active',
]);
export const unitSystemEnum = pgEnum('unit_system', ['imperial', 'metric']);
export const waterUnitEnum = pgEnum('water_unit', ['ml', 'fl_oz', 'cups']);

// Food scanning
export const scanModeEnum = pgEnum('scan_mode', ['scan_food', 'barcode', 'food_label', 'gallery']);
export const scanStatusEnum = pgEnum('scan_status', [
  'created',
  'uploading',
  'queued',
  'analyzing',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
]);
export const visionProviderEnum = pgEnum('vision_provider', ['snapcalorie', 'gemini']);

// Infrastructure
export const jobStatusEnum = pgEnum('job_status', ['queued', 'running', 'completed', 'failed']);

// Tracking
export const activitySourceEnum = pgEnum('activity_source', ['apple_health', 'health_connect']);

// Fasting
export const fastingProtocolEnum = pgEnum('fasting_protocol', ['12_12', '14_10', '16_8', 'custom']);
export const fastingSessionStatusEnum = pgEnum('fasting_session_status', [
  'running',
  'completed',
  'cancelled',
]);

// Home and reminders
export const ringStateEnum = pgEnum('ring_state', ['green', 'yellow', 'red', 'dotted']);
export const reminderKindEnum = pgEnum('reminder_kind', [
  'breakfast',
  'lunch',
  'snack',
  'dinner',
  'end_of_day',
]);

// Groups
export const groupVisibilityEnum = pgEnum('group_visibility', ['public', 'private']);
export const groupRoleEnum = pgEnum('group_role', ['owner', 'member']);

// Notifications
export const notificationTypeEnum = pgEnum('notification_type', [
  'message_reply',
  'group_posts_digest',
  'message_reaction',
  'leaderboard_passed',
  'badge_earned',
]);

// Progress and reports
export const bmiCategoryEnum = pgEnum('bmi_category', [
  'underweight',
  'healthy',
  'overweight',
  'obese',
]);
export const changeTrendEnum = pgEnum('change_trend', ['no_change', 'increase', 'decrease']);
export const reportRangeEnum = pgEnum('report_range', [
  'last_7_days',
  'last_30_days',
  'all_time',
  'custom',
]);

// The TypeScript union of one enum's values, for use outside the schema:
//   type UserStatus = EnumValue<typeof userStatusEnum>  // 'active' | 'suspended' | ...
// (TypeScript notes, entry 26)
export type EnumValue<E extends { enumValues: readonly string[] }> = E['enumValues'][number];
