CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_subject" text NOT NULL,
	"email_at_provider" text,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject" ON "auth_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_id" ON "auth_identities" USING btree ("user_id");