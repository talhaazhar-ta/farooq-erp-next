-- Balance-enforcing trigger: a journal_entries row's lines must sum
-- debit == credit by commit time. Deferred so multi-line entries can be
-- inserted line-by-line inside one transaction. See test/balance-trigger.test.ts.
CREATE OR REPLACE FUNCTION check_journal_balance() RETURNS trigger AS $$
DECLARE
  v_entry_id uuid;
  v_debit bigint;
  v_credit bigint;
BEGIN
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(debit_p), 0), COALESCE(SUM(credit_p), 0)
    INTO v_debit, v_credit
    FROM journal_lines WHERE entry_id = v_entry_id;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'journal_entries % is unbalanced: debit % <> credit %', v_entry_id, v_debit, v_credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_lines_balance_check ON journal_lines;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balance();
--> statement-breakpoint

-- Least-privilege role the running app connects as (never the migration
-- role). The password below is a placeholder, immediately overwritten by
-- `src/db/migrate.ts` from APP_DATABASE_URL's real (never-committed) secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'farooq_app') THEN
    CREATE ROLE farooq_app LOGIN PASSWORD 'placeholder-overwritten-by-migrate-ts';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO farooq_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farooq_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farooq_app;
--> statement-breakpoint

-- Audit log is append-only (CLAUDE.md rule): the app role may read and
-- insert, but never update or delete a row once written.
REVOKE UPDATE, DELETE ON audit_log FROM farooq_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO farooq_app;
