ALTER TABLE "sessions" ADD COLUMN "previous_refresh_token_hash" text;--> statement-breakpoint
CREATE INDEX "sessions_previous_refresh_token_hash" ON "sessions" USING btree ("previous_refresh_token_hash");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_previous_refresh_token_hash_format" CHECK ("sessions"."previous_refresh_token_hash" ~ '^[0-9a-f]{64}$');