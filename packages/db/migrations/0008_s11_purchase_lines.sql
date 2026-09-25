CREATE TABLE "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"purchase_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"description_snapshot" text,
	"description_en_snapshot" text,
	"brand_snapshot" text,
	"package_snapshot" text,
	"unit" text DEFAULT 'Bag' NOT NULL,
	"qty_milli" bigint NOT NULL,
	"received_qty_milli" bigint DEFAULT 0 NOT NULL,
	"returned_qty_milli" bigint DEFAULT 0 NOT NULL,
	"unit_price_p" bigint NOT NULL,
	"discount_p" bigint DEFAULT 0 NOT NULL,
	"tax_p" bigint DEFAULT 0 NOT NULL,
	"line_total_p" bigint NOT NULL,
	"goods_unit_cost_p" bigint,
	"charge_share_p" bigint,
	"landed_unit_cost_p" bigint,
	"operational_share_p" bigint,
	"batch_no" text,
	"notes" text,
	"legacy_doc" jsonb,
	CONSTRAINT "purchase_items_legacy_id_unique" UNIQUE("legacy_id"),
	CONSTRAINT "purchase_items_qty_chk" CHECK ("purchase_items"."qty_milli" > 0 AND "purchase_items"."received_qty_milli" >= 0 AND "purchase_items"."returned_qty_milli" >= 0),
	CONSTRAINT "purchase_items_money_chk" CHECK ("purchase_items"."unit_price_p" >= 0 AND "purchase_items"."discount_p" >= 0 AND "purchase_items"."tax_p" >= 0 AND "purchase_items"."line_total_p" >= 0),
	CONSTRAINT "purchase_items_discount_chk" CHECK (1000 * "purchase_items"."discount_p" <= "purchase_items"."unit_price_p" * "purchase_items"."qty_milli" + 500)
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "supplier_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "supplier_invoice_no" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "warehouse_snapshot" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "vehicle_no" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "driver" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "delivery_ref" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "subtotal_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "discount_amount_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "tax_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "freight_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "loading_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "other_charges_p" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "total_qty_milli" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "ordered_qty_milli" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "received_qty_milli" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "line_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "stock_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "migrated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "client_op_id" text;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_items_purchase_idx" ON "purchase_items" USING btree ("purchase_id","sort_order");--> statement-breakpoint
CREATE INDEX "purchase_items_product_idx" ON "purchase_items" USING btree ("product_id","warehouse_id");--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchases_warehouse_idx" ON "purchases" USING btree ("warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_purchase_number_uq" ON "purchases" USING btree ("purchase_number") WHERE "purchases"."purchase_number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_amounts_chk" CHECK ("purchases"."subtotal_p" >= 0 AND "purchases"."discount_amount_p" >= 0 AND "purchases"."tax_p" >= 0 AND "purchases"."freight_p" >= 0 AND "purchases"."loading_p" >= 0 AND "purchases"."other_charges_p" >= 0 AND "purchases"."total_qty_milli" >= 0 AND "purchases"."ordered_qty_milli" >= 0 AND "purchases"."received_qty_milli" >= 0 AND "purchases"."line_count" >= 0);--> statement-breakpoint
-- Hand-appended (drizzle-kit does not generate grants or comments).
-- purchase_items is NOT append-only (an S12 edit updates a line in place: its id stays stable because supplier returns and landed-cost
-- entries point at it), but nobody except the migration owner may TRUNCATE it. The default privileges already leave TRUNCATE out; this says so.
REVOKE TRUNCATE ON purchase_items FROM farooq_app;
--> statement-breakpoint
COMMENT ON TABLE purchase_items IS 'One line of a supplier bill. The godown is per line; qty_milli = bags ORDERED, received_qty_milli = bags that ARRIVED (stock moves on the received ones). Cost columns: S12 writes goods_unit_cost_p / charge_share_p / landed_unit_cost_p (allocateCharges in @farooq/shared); M6 (landed cost) writes operational_share_p and folds it into landed_unit_cost_p. NULL = never computed.';
--> statement-breakpoint
COMMENT ON COLUMN purchase_items.received_qty_milli IS 'Resolved from the legacy receivedQty: ABSENT there means the whole quantity, 0 means nothing arrived. The raw value is kept in legacy_doc. Not capped at qty_milli (the legacy allowed raising the ordered quantity on a full load).';
--> statement-breakpoint
COMMENT ON COLUMN purchase_items.discount_p IS 'Line discount; the CHECK purchase_items_discount_chk refuses more than the line gross (legacy bug fixed, S11 decision 3.2).';
--> statement-breakpoint
COMMENT ON COLUMN purchases.discount_amount_p IS 'The legacy keeps line discounts + the overall discount as ONE figure and this keeps that meaning; the overall part is this minus the sum of the line discounts.';
--> statement-breakpoint
COMMENT ON COLUMN stock_levels.avg_cost_p IS 'Weighted average over every non-cancelled purchase line of this product x warehouse, by bags received, on the landed basis (setting profitCostBasis; default LANDED). Carried verbatim from the legacy inventory row; the importer reconciliation recomputes it (shared purchaseCost.weightedAverage). A row with no purchase line behind it keeps whatever it had. S12 maintains it on a purchase save.';
