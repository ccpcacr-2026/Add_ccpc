-- ═══════════════════════════════════════════════════════
-- CCPC Admission — Full Schema
-- Run in Supabase SQL editor
-- ═══════════════════════════════════════════════════════

-- ── Tracking ID: hex sequence (starts 0x1000) ────────────────────────────
CREATE SEQUENCE IF NOT EXISTS tracking_id_seq START 4096 INCREMENT 1;

CREATE OR REPLACE FUNCTION public.generate_tracking_id()
RETURNS TEXT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT upper(lpad(to_hex(nextval('tracking_id_seq')), 4, '0'));
$$;

-- ── Index ID: atomic counter per year+class ──────────────────────────────
CREATE TABLE IF NOT EXISTS index_counters (
  year    TEXT NOT NULL,
  class   TEXT NOT NULL,
  counter INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (year, class)
);

CREATE OR REPLACE FUNCTION public.increment_index_counter(p_year TEXT, p_class TEXT)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v INT;
BEGIN
  INSERT INTO index_counters (year, class, counter) VALUES (p_year, p_class, 1)
  ON CONFLICT (year, class)
  DO UPDATE SET counter = index_counters.counter + 1
  RETURNING counter INTO v;
  RETURN v;
END;
$$;

-- ── Settings (form layout, admit card layout, index pattern) ─────────────
CREATE TABLE IF NOT EXISTS admission_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO admission_settings (key, value) VALUES
('index_settings', '{
  "pattern": "{YY}{CLASS}{SEQ4}",
  "classCodes": {
    "Nursery":"NU","KG":"KG","One":"01","Two":"02","Three":"03","Four":"04","Five":"05",
    "Six":"06","Seven":"07","Eight":"08","Nine":"09","Ten":"10","Eleven":"11","Twelve":"12"
  },
  "categoryCodes": {"Army":"A","Civil":"C","Defence":"D","CCPC Teacher":"T","Staff":"S"}
}'),
('form_settings',       '{}'),
('admit_card_settings', '{}'),
-- form_fields_json is deliberately NOT seeded here -- the server
-- reconciles whatever's stored (even nothing) against a canonical
-- built-in field list on every read (app/api/apply/route.js), so a
-- missing/empty row self-heals to the same effective default as an
-- explicit seed would, without duplicating a 40+ field blob in two
-- places. See migration_form_fields.sql for the one-time seed used on
-- an already-running install (skipped here via ON CONFLICT DO NOTHING
-- once this table exists either way).
-- {method, url, headers, bodyTemplate} for sending OTP SMS — provider-
-- agnostic on purpose; stays empty until the admin configures a real SMS
-- API in the SMS settings tab. While empty, requestOtp returns the code
-- directly in its response instead of sending it (dev/testing fallback).
('sms_settings',        '{}')
ON CONFLICT (key) DO NOTHING;

-- ── Applications ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admission_applications (
  id            BIGSERIAL PRIMARY KEY,
  tracking_id   TEXT UNIQUE,
  index_id      TEXT,
  session       TEXT,
  class         TEXT,
  category      TEXT,
  version       TEXT,
  quota         TEXT DEFAULT 'No',
  status        TEXT DEFAULT 'Pending',
  stage         TEXT DEFAULT 'initiated',
  source        TEXT DEFAULT 'admin',

  -- Applicant identity: EITHER email/Google OR phone+OTP, never both at
  -- once (see migration_phone_otp.sql) — no uniqueness constraint on
  -- either, consistent with one applicant being able to hold several
  -- applications (one per class/session/category/version combo).
  applicant_email   TEXT,
  applicant_phone   TEXT,

  -- Application-fee payment (see admission_payments below for the actual
  -- gateway/manual transaction log; these are just the application's own
  -- current payment state).
  payment_status    TEXT DEFAULT 'none',
  payment_method    TEXT,
  payment_ref       TEXT,
  payment_amount    NUMERIC,
  paid_at           TIMESTAMPTZ,

  -- Admit card issuance
  room_no           TEXT,
  admit_issued_at   TIMESTAMPTZ,

  name_english      TEXT,
  name_bangla       TEXT,
  date_of_birth     DATE,
  blood_group       TEXT,
  religion          TEXT,
  birth_reg_no      TEXT,
  gender            TEXT,
  nationality       TEXT DEFAULT 'Bangladeshi',
  emergency_contact TEXT,
  height            TEXT,
  last_class        TEXT,
  last_version      TEXT,
  last_institute    TEXT,
  present_address   TEXT,
  permanent_address TEXT,
  co_curricular     TEXT,
  student_photo     TEXT,

  father_name           TEXT,
  father_profession     TEXT,
  father_designation    TEXT,
  father_education      TEXT,
  father_contact        TEXT,
  father_nid            TEXT,
  father_office_address TEXT,
  father_yearly_income  TEXT,
  father_photo          TEXT,

  mother_name           TEXT,
  mother_profession     TEXT,
  mother_designation    TEXT,
  mother_education      TEXT,
  mother_contact        TEXT,
  mother_nid            TEXT,
  mother_office_address TEXT,
  mother_yearly_income  TEXT,
  mother_photo          TEXT,

  guardian_name           TEXT,
  guardian_profession     TEXT,
  guardian_designation    TEXT,
  guardian_education      TEXT,
  guardian_contact        TEXT,
  guardian_relation       TEXT,
  guardian_office_address TEXT,
  guardian_photo          TEXT,

  academic_records JSONB DEFAULT '[]',
  siblings         JSONB DEFAULT '[]',

  -- Answers for admin-added custom fields (see admission_settings's
  -- form_fields_json) -- built-in fields keep living as the real columns
  -- above; a field the admin adds on the fly has nowhere else to live.
  extra_fields     JSONB DEFAULT '{}',

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Run this if table already exists (adds columns to existing rows)
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS academic_records JSONB DEFAULT '[]';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS siblings         JSONB DEFAULT '[]';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS extra_fields     JSONB DEFAULT '{}';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS stage            TEXT DEFAULT 'initiated';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS source           TEXT DEFAULT 'admin';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS applicant_email  TEXT;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS applicant_phone  TEXT;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_status   TEXT DEFAULT 'none';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_method   TEXT;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_ref      TEXT;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_amount   NUMERIC;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS room_no          TEXT;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS admit_issued_at  TIMESTAMPTZ;

-- ── Payments (gateway + manual transaction log, one row per attempt) ───────
CREATE TABLE IF NOT EXISTS admission_payments (
  id              BIGSERIAL PRIMARY KEY,
  application_id  BIGINT      NOT NULL,
  tran_id         TEXT        NOT NULL UNIQUE,
  gateway         TEXT        NOT NULL,
  amount          NUMERIC     NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'BDT',
  status          TEXT        NOT NULL DEFAULT 'initiated',
  val_id          TEXT,
  payer_ref       TEXT,
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admission_payments_application_idx ON admission_payments (application_id);
ALTER TABLE admission_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access payments" ON admission_payments;
CREATE POLICY "Full access payments" ON admission_payments FOR ALL USING (true);

-- ── OTP codes (phone sign-in) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admission_otps (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT        NOT NULL,
  code_hash   TEXT        NOT NULL,
  purpose     TEXT        NOT NULL DEFAULT 'login',
  attempts    INT         NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admission_otps_phone_created_idx ON admission_otps (phone, created_at DESC);
ALTER TABLE admission_otps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access otps" ON admission_otps;
CREATE POLICY "Full access otps" ON admission_otps FOR ALL USING (true);

-- RLS
ALTER TABLE admission_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access admission" ON admission_applications;
CREATE POLICY "Full access admission" ON admission_applications FOR ALL USING (true);

ALTER TABLE index_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access counters" ON index_counters;
CREATE POLICY "Full access counters" ON index_counters FOR ALL USING (true);

ALTER TABLE admission_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access settings" ON admission_settings;
CREATE POLICY "Full access settings" ON admission_settings FOR ALL USING (true);

-- Grant RPC access
GRANT EXECUTE ON FUNCTION public.generate_tracking_id() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_index_counter(TEXT, TEXT) TO anon, authenticated, service_role;
