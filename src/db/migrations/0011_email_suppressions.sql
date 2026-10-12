CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"provider_event_id" text,
	"last_event_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_suppressions_reason" CHECK ("email_suppressions"."reason" in ('bounce', 'complaint')),
	CONSTRAINT "email_suppressions_email_lowercase" CHECK ("email_suppressions"."email" = lower("email_suppressions"."email"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_email" ON "email_suppressions" USING btree ("email");