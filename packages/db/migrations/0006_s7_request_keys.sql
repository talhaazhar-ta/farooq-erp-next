CREATE TABLE "request_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
