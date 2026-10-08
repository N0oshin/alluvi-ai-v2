CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text,
	"first_name" text NOT NULL,
	"last_name" text,
	"username" text,
	"avatar_kind" "avatar_kind" DEFAULT 'initials' NOT NULL,
	"avatar_color" smallint,
	"avatar_media_id" uuid,
	"time_zone" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	CONSTRAINT "users_first_name_length" CHECK (char_length("users"."first_name") between 1 and 50),
	CONSTRAINT "users_last_name_length" CHECK (char_length("users"."last_name") <= 50),
	CONSTRAINT "users_username_format" CHECK ("users"."username" is null or "users"."username" ~ '^[A-Za-z0-9_.]{3,20}$'),
	CONSTRAINT "users_avatar_color_range" CHECK ("users"."avatar_color" between 1 and 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower" ON "users" USING btree (lower("email")) WHERE "users"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower" ON "users" USING btree (lower("username")) WHERE "users"."username" is not null;