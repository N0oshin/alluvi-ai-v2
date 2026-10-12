CREATE TYPE "public"."acquisition_source" AS ENUM('facebook', 'tiktok', 'friend_or_family', 'instagram', 'youtube', 'app_store', 'tv');--> statement-breakpoint
CREATE TYPE "public"."plan_step" AS ENUM('calories', 'carbs', 'protein', 'fats', 'health_score');--> statement-breakpoint
CREATE TABLE "onboarding_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"guest_session_id" uuid,
	"user_id" uuid,
	"sex" "sex",
	"workout_frequency" "workout_frequency",
	"birth_date" date,
	"acquisition_source" "acquisition_source",
	"tried_other_apps" boolean,
	"height_cm" numeric(5, 2),
	"weight_kg" numeric(5, 1),
	"target_weight_kg" numeric(5, 1),
	"works_with_professional" boolean,
	"goal" "weight_goal_direction",
	"obstacle" "obstacle",
	"motivation" "motivation",
	"sync_workouts" boolean,
	"add_burned_calories" boolean,
	"rollover_calories" boolean,
	"unit_system" "unit_system",
	"completed_at" timestamp with time zone,
	CONSTRAINT "onboarding_responses_one_owner" CHECK (num_nonnulls("onboarding_responses"."guest_session_id", "onboarding_responses"."user_id") = 1),
	CONSTRAINT "onboarding_responses_height_range" CHECK ("onboarding_responses"."height_cm" between 90 and 250),
	CONSTRAINT "onboarding_responses_weight_range" CHECK ("onboarding_responses"."weight_kg" between 20 and 400),
	CONSTRAINT "onboarding_responses_target_weight_range" CHECK ("onboarding_responses"."target_weight_kg" between 20 and 400),
	CONSTRAINT "onboarding_responses_birth_date_floor" CHECK ("onboarding_responses"."birth_date" >= date '1900-01-01')
);
--> statement-breakpoint
CREATE TABLE "plan_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"onboarding_response_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress_pct" smallint DEFAULT 0 NOT NULL,
	"steps_completed" "plan_step"[] DEFAULT '{}' NOT NULL,
	"result" jsonb,
	"algorithm_version" text,
	"failure_code" text,
	CONSTRAINT "plan_generations_progress_range" CHECK ("plan_generations"."progress_pct" between 0 and 100),
	CONSTRAINT "plan_generations_completed_has_result" CHECK ("plan_generations"."status" <> 'completed' or ("plan_generations"."result" is not null and "plan_generations"."algorithm_version" is not null)),
	CONSTRAINT "plan_generations_failed_has_code" CHECK ("plan_generations"."status" <> 'failed' or "plan_generations"."failure_code" is not null)
);
--> statement-breakpoint
ALTER TABLE "onboarding_responses" ADD CONSTRAINT "onboarding_responses_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_responses" ADD CONSTRAINT "onboarding_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_generations" ADD CONSTRAINT "plan_generations_onboarding_response_id_onboarding_responses_id_fk" FOREIGN KEY ("onboarding_response_id") REFERENCES "public"."onboarding_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_responses_guest_session_id" ON "onboarding_responses" USING btree ("guest_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_responses_user_id" ON "onboarding_responses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plan_generations_response_created" ON "plan_generations" USING btree ("onboarding_response_id","created_at" DESC NULLS LAST);