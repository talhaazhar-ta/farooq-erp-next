-- S8: the invoice search, and one ordering fix.
-- Hand-written part first: the six-argument search_join (S4 made 2, 3, 4, 5, 7 and 8) — the generated columns below call it, so it
-- must exist before them.
CREATE FUNCTION "search_join"(p1 text, p2 text, p3 text, p4 text, p5 text, p6 text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
SELECT concat_ws(chr(1), NULLIF(fold_search(p1), ''), NULLIF(fold_search(p2), ''), NULLIF(fold_search(p3), ''), NULLIF(fold_search(p4), ''), NULLIF(fold_search(p5), ''), NULLIF(fold_search(p6), ''))
$fn$;--> statement-breakpoint
-- Generated part (drizzle-kit). journal_entries.created_at now defaults to clock_timestamp(): now() is the TRANSACTION's start time, so an
-- invoice and the receipt taken with it (one transaction) tied, and a statement / the printed invoice's account block ordered them by a random id.
-- Then: folded search text of an invoice (number / customer / amount / date / other) and of a line. Not stored: the shop's CURRENT text, the
-- receipts applied and the payment-status word — those follow other tables and are read at query time.
ALTER TABLE "journal_entries" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "search_text" text GENERATED ALWAYS AS (fold_search(COALESCE(description_en_snapshot, '') || ' ' || COALESCE(description_snapshot, '') || ' ' || COALESCE(brand_snapshot, ''))) STORED;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "search_numbers" text GENERATED ALWAYS AS (search_join(invoice_number, search_compact(invoice_number), order_number, dispatch_number, reference_no)) STORED;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "search_customer" text GENERATED ALWAYS AS (search_join(shop_name_snapshot, customer_name_snapshot, mobile_snapshot, search_compact(mobile_snapshot), region_snapshot)) STORED;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "search_amount" text GENERATED ALWAYS AS (search_amount_text(total_p)) STORED;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "search_date" text GENERATED ALWAYS AS (search_date_text(date)) STORED;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "search_other" text GENERATED ALWAYS AS (search_join(notes, description, salesperson, payment_method, warehouse_snapshot, CASE status WHEN 'DRAFT' THEN 'Draft' WHEN 'CONFIRMED' THEN 'Confirmed' WHEN 'DISPATCHED' THEN 'Dispatched' WHEN 'PARTIALLY_PAID' THEN 'Partly paid' WHEN 'PAID' THEN 'Paid' WHEN 'CANCELLED' THEN 'Cancelled' WHEN 'RETURNED' THEN 'Returned' WHEN 'PARTIALLY_RETURNED' THEN 'Partly returned' END)) STORED;