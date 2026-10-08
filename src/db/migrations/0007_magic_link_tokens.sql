CREATE TYPE "public"."magic_intent" AS ENUM('sign_in', 'sign_up');--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"intent" "magic_intent" NOT NULL,
	"guest_session_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_ip" "inet",
	"requested_device_id" uuid,
	CONSTRAINT "magic_link_tokens_token_hash_format" CHECK ("magic_link_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "magic_link_tokens_email_lowercase" CHECK ("magic_link_tokens"."email" = lower("magic_link_tokens"."email"))
);
--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_tokens_token_hash" ON "magic_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "magic_link_tokens_email_created" ON "magic_link_tokens" USING btree ("email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "magic_link_tokens_guest_session_id" ON "magic_link_tokens" USING btree ("guest_session_id");--> statement-breakpoint
CREATE INDEX "magic_link_tokens_expires_at" ON "magic_link_tokens" USING btree ("expires_at");