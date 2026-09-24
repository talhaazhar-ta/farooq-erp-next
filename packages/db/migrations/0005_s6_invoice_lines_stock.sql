CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"invoice_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"description_snapshot" text,
	"description_en_snapshot" text,
	"brand_snapshot" text,
	"category_snapshot" text,
	"package_snapshot" text,
	"sku_snapshot" text,
	"unit" text DEFAULT 'Bag' NOT NULL,
	"qty_milli" bigint NOT NULL,
	"unit_price_p" bigint NOT NULL,
	"discount_p" bigint DEFAULT 0 NOT NULL,
	"tax_p" bigint DEFAULT 0 NOT NULL,
	"line_total_p" bigint NOT NULL,
	"cost_snapshot_p" bigint,
	"returned_qty_milli" bigint DEFAULT 0 NOT NULL,
	"batch_no" text,
	"notes" text,
	"legacy_doc" jsonb,
	CONSTRAINT "invoice_items_legacy_id_unique" UNIQUE("legacy_id"),
	CONSTRAINT "invoice_items_qty_chk" CHECK ("invoice_items"."qty_milli" > 0 AND "invoice_items"."returned_qty_milli" >= 0 AND "invoice_items"."returned_qty_milli" <= "invoice_items"."qty_milli"),
	CONSTRAINT "invoice_items_money_chk" CHECK ("invoice_items"."unit_price_p" >= 0 AND "invoice_items"."discount_p" >= 0 AND "invoice_items"."tax_p" >= 0 AND "invoice_items"."line_total_p" >= 0),
	CONSTRAINT "invoice_items_discount_chk" CHECK (1000 * "invoice_items"."discount_p" <= "invoice_items"."unit_price_p" * "invoice_items"."qty_milli" + 500)
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bucket" text DEFAULT 'stock' NOT NULL,
	"qty_milli" bigint DEFAULT 0 NOT NULL,
	"avg_cost_p" bigint DEFAULT 0 NOT NULL,
	"last_cost_p" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_product_id_warehouse_id_bucket_pk" PRIMARY KEY("product_id","warehouse_id","bucket"),
	CONSTRAINT "stock_levels_bucket_chk" CHECK ("stock_levels"."bucket" IN ('stock', 'damaged'))
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"bucket" text DEFAULT 'stock' NOT NULL,
	"qty_delta_milli" bigint NOT NULL,
	"unit_cost_p" bigint,
	"ref" text,
	"ref_type" text,
	"source_type" text,
	"source_id" uuid,
	"note" text,
	"created_by" uuid,
	"legacy_doc" jsonb,
	CONSTRAINT "stock_movements_legacy_id_unique" UNIQUE("legacy_id"),
	CONSTRAINT "stock_movements_bucket_chk" CHECK ("stock_movements"."bucket" IN ('stock', 'damaged')),
	CONSTRAINT "stock_movements_qty_chk" CHECK ("stock_movements"."qty_delta_milli" <> 0)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "invoice_type" text DEFAULT 'SALE' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "salesperson" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "subtotal_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "item_discounts_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "invoice_discount_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "freight_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "loading_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "other_charges_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reference_no" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "previous_balance_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "total_qty_milli" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "line_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "stock_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "migrated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sale_order_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "order_number" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "dispatch_number" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "customer_code_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "customer_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "shop_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "contact_person_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "mobile_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "whatsapp_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "address_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "region_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "market_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "warehouse_snapshot" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "name_ur" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "name_en" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brand_en" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "weight_kg" double precision;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "buy_p" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sell_p" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "extra_p" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "min_sell_p" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "wholesale_p" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "retail_p" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_pct" double precision;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_pct" double precision;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "reorder" double precision;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_items_invoice_idx" ON "invoice_items" USING btree ("invoice_id","sort_order");--> statement-breakpoint
CREATE INDEX "invoice_items_product_idx" ON "invoice_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "stock_movements_level_idx" ON "stock_movements" USING btree ("product_id","warehouse_id","bucket");--> statement-breakpoint
CREATE INDEX "stock_movements_source_idx" ON "stock_movements" USING btree ("source_type","source_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_warehouse_idx" ON "invoices" USING btree ("warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_invoice_number_uq" ON "invoices" USING btree ("invoice_number") WHERE "invoices"."invoice_number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_chk" CHECK ("invoices"."subtotal_p" >= 0 AND "invoices"."item_discounts_p" >= 0 AND "invoices"."invoice_discount_p" >= 0 AND "invoices"."tax_p" >= 0 AND "invoices"."freight_p" >= 0 AND "invoices"."loading_p" >= 0 AND "invoices"."other_charges_p" >= 0 AND "invoices"."total_qty_milli" >= 0 AND "invoices"."line_count" >= 0);
--> statement-breakpoint
-- Hand-appended (drizzle-kit does not generate grants or comments).
-- stock_movements is append-only (S6), like audit_log: the app role may read and insert, never update or delete a row.
-- The default privileges granted UPDATE/DELETE on every new table, so they are taken back here.
REVOKE UPDATE, DELETE ON stock_movements FROM farooq_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON stock_movements TO farooq_app;
--> statement-breakpoint
COMMENT ON COLUMN stock_levels.avg_cost_p IS 'Carried verbatim from the legacy inventory row (stock bucket). Read by costOf; maintained by purchases / conversions from M3-M4. Nothing in M2 recomputes it.';
--> statement-breakpoint
COMMENT ON COLUMN stock_levels.last_cost_p IS 'Carried verbatim from the legacy inventory row (stock bucket). Maintained from M3-M4.';
--> statement-breakpoint
COMMENT ON TABLE stock_movements IS 'Append-only stock ledger. stock_levels.qty_milli must equal the sum of qty_delta_milli per (product, warehouse, bucket): the importer reconciliation proves it, the services (S7) keep it in one transaction.';
