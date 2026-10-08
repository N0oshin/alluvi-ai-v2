CREATE TABLE "user_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_type" "consent_type" NOT NULL,
	"document_version" text NOT NULL,
	"granted" boolean NOT NULL,
	"source_ip" "inet",
	CONSTRAINT "user_consents_document_version_length" CHECK (char_length("user_consents"."document_version") between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_consents_user_type_created" ON "user_consents" USING btree ("user_id","consent_type","created_at" DESC NULLS LAST);