CREATE TABLE "account_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"adjustment_number" text,
	"customer_id" uuid NOT NULL,
	"date" date NOT NULL,
	"direction" text NOT NULL,
	"amount_p" bigint NOT NULL,
	"reason" text,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_doc" jsonb,
	CONSTRAINT "account_adjustments_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "milling_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"job_number" text,
	"supplier_id" uuid NOT NULL,
	"date" date NOT NULL,
	"settle" text,
	"receive_mode" text,
	"issued_value_p" bigint DEFAULT 0 NOT NULL,
	"received_value_p" bigint DEFAULT 0 NOT NULL,
	"fee_amount_p" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_doc" jsonb,
	CONSTRAINT "milling_jobs_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid,
	"purchase_id" uuid,
	"amount_p" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_legacy_id_unique" UNIQUE("legacy_id"),
	CONSTRAINT "payment_allocations_one_target_chk" CHECK (num_nonnulls("payment_allocations"."invoice_id", "payment_allocations"."purchase_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"direction" text NOT NULL,
	"party_type" text NOT NULL,
	"party_id" uuid NOT NULL,
	"is_refund" boolean DEFAULT false NOT NULL,
	"amount_p" bigint NOT NULL,
	"method" text,
	"reference" text,
	"note" text,
	"payment_date" date NOT NULL,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"receipt_number" text NOT NULL,
	"received_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_doc" jsonb,
	CONSTRAINT "payments_legacy_id_unique" UNIQUE("legacy_id"),
	CONSTRAINT "payments_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "payments_direction_chk" CHECK ("payments"."direction" IN ('IN', 'OUT')),
	CONSTRAINT "payments_party_type_chk" CHECK ("payments"."party_type" IN ('CUSTOMER', 'SUPPLIER')),
	CONSTRAINT "payments_status_chk" CHECK ("payments"."status" IN ('POSTED', 'REVERSED'))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "opening_balance_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "opening_balance_date" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_cash_counter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "legacy_code" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "purchase_number" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "regions" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "return_number" text;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "treatment" text;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "refund_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "opening_balance_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "opening_balance_date" date;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "legacy_doc" jsonb;--> statement-breakpoint
ALTER TABLE "account_adjustments" ADD CONSTRAINT "account_adjustments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milling_jobs" ADD CONSTRAINT "milling_jobs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_party_idx" ON "payments" USING btree ("party_type","party_id");--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_refund_payment_id_payments_id_fk" FOREIGN KEY ("refund_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_invoice_number_idx" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_uq" ON "journal_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "purchases_purchase_number_idx" ON "purchases" USING btree ("purchase_number");--> statement-breakpoint
CREATE INDEX "returns_return_number_idx" ON "returns" USING btree ("return_number");
--> statement-breakpoint
-- Control accounts (hand-appended; drizzle-kit does not generate data). Single accounts,
-- with party_type/party_id carried on the journal LINES, not one account per shop/supplier:
-- a party's balance is the sum of its lines on RECEIVABLES (customers) / PAYABLES (suppliers).
-- Seeded here rather than by the importer so S3's payment services have them regardless of any import.
-- MILLING_CLEARING / MILLING_FEES / ACCOUNT_ADJUSTMENTS are provisional counter-accounts for ledger-feeding
-- documents the legacy app added later (32-milling.js, 16-khata.js); their final accounting is M8's/the owner's call.
INSERT INTO "accounts" ("code", "name", "type") VALUES
  ('CASH', 'Cash and bank', 'ASSET'),
  ('RECEIVABLES', 'Receivables (shops)', 'ASSET'),
  ('PAYABLES', 'Payables (suppliers)', 'LIABILITY'),
  ('SALES', 'Sales', 'INCOME'),
  ('SALES_RETURNS', 'Sales returns (contra-income)', 'INCOME'),
  ('PURCHASES', 'Purchases', 'EXPENSE'),
  ('PURCHASE_RETURNS', 'Purchase returns (contra-expense)', 'EXPENSE'),
  ('OPENING_EQUITY', 'Opening balance equity', 'EQUITY'),
  ('ACCOUNT_ADJUSTMENTS', 'Account adjustments (provisional)', 'EXPENSE'),
  ('MILLING_CLEARING', 'Milling clearing (provisional)', 'ASSET'),
  ('MILLING_FEES', 'Milling fees (provisional)', 'EXPENSE')
ON CONFLICT ("code") DO NOTHING;
