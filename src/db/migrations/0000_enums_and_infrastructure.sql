CREATE TYPE "public"."activity_level" AS ENUM('sedentary', 'light', 'moderate', 'active');--> statement-breakpoint
CREATE TYPE "public"."activity_source" AS ENUM('apple_health', 'health_connect');--> statement-breakpoint
CREATE TYPE "public"."appearance" AS ENUM('automatic', 'light', 'dark');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('apple', 'google', 'email');--> statement-breakpoint
CREATE TYPE "public"."avatar_kind" AS ENUM('initials', 'uploaded');--> statement-breakpoint
CREATE TYPE "public"."bmi_category" AS ENUM('underweight', 'healthy', 'overweight', 'obese');--> statement-breakpoint
CREATE TYPE "public"."change_trend" AS ENUM('no_change', 'increase', 'decrease');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('terms_and_privacy', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."fasting_protocol" AS ENUM('12_12', '14_10', '16_8', 'custom');--> statement-breakpoint
CREATE TYPE "public"."fasting_session_status" AS ENUM('running', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."group_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."group_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."motivation" AS ENUM('eat_healthier', 'energy_mood', 'stay_motivated', 'body_confidence');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('message_reply', 'group_posts_digest', 'message_reaction', 'leaderboard_passed', 'badge_earned');--> statement-breakpoint
CREATE TYPE "public"."obstacle" AS ENUM('consistency', 'eating_habits', 'support', 'busy_schedule', 'meal_inspiration');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('breakfast', 'lunch', 'snack', 'dinner', 'end_of_day');--> statement-breakpoint
CREATE TYPE "public"."report_range" AS ENUM('last_7_days', 'last_30_days', 'all_time', 'custom');--> statement-breakpoint
CREATE TYPE "public"."ring_state" AS ENUM('green', 'yellow', 'red', 'dotted');--> statement-breakpoint
CREATE TYPE "public"."scan_mode" AS ENUM('scan_food', 'barcode', 'food_label', 'gallery');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('created', 'uploading', 'queued', 'analyzing', 'finalizing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female', 'other');--> statement-breakpoint
CREATE TYPE "public"."unit_system" AS ENUM('imperial', 'metric');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'pending_deletion', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."vision_provider" AS ENUM('snapcalorie', 'gemini');--> statement-breakpoint
CREATE TYPE "public"."water_unit" AS ENUM('ml', 'fl_oz', 'cups');--> statement-breakpoint
CREATE TYPE "public"."weight_goal_direction" AS ENUM('lose', 'maintain', 'gain');--> statement-breakpoint
CREATE TYPE "public"."workout_frequency" AS ENUM('0_2', '3_5', '6_plus');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"device_id" uuid,
	"request_id" uuid,
	"ip" "inet",
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "audit_log_actor_created" ON "audit_log" USING btree ("actor_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_target" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_subject_key" ON "idempotency_keys" USING btree ("subject_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_pending" ON "outbox" USING btree ("id") WHERE "outbox"."published_at" is null;