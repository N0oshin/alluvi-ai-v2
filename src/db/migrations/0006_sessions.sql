CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"claimed_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guest_sessions_token_hash_format" CHECK ("guest_sessions"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_sessions_token_hash" ON "guest_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_sessions_device_id" ON "guest_sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "guest_sessions_claimed_by_user_id" ON "guest_sessions" USING btree ("claimed_by_user_id");--> statement-breakpoint
CREATE INDEX "guest_sessions_expires_at" ON "guest_sessions" USING btree ("expires_at");