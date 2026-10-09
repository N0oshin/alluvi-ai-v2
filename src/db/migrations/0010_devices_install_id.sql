ALTER TABLE "devices" ADD COLUMN "install_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_install_id" ON "devices" USING btree ("install_id");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_install_id_length" CHECK (char_length("devices"."install_id") between 8 and 128);