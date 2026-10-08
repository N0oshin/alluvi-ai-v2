CREATE TYPE "public"."permission_state" AS ENUM('granted', 'denied', 'not_determined');--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"platform" "platform" NOT NULL,
	"push_token" text,
	"push_permission" "permission_state" DEFAULT 'not_determined' NOT NULL,
	"exact_alarm_permission" "permission_state",
	"app_version" text,
	"os_version" text
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_id" ON "devices" USING btree ("user_id");