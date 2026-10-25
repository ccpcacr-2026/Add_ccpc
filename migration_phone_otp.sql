-- ═══════════════════════════════════════════════════════
-- CCPC Admission — Phone/OTP sign-in + schema catch-up
-- Run in Supabase SQL editor
-- ═══════════════════════════════════════════════════════

-- ── Phone identity on applications ───────────────────────────────────────
-- Nullable, same as applicant_email (no uniqueness constraint, consistent
-- with how applicant_email already works) — an applicant signs in with
-- EITHER email/Google OR phone+OTP, never both at once.
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS applicant_phone text;

-- ── OTP codes ─────────────────────────────────────────────────────────────
-- code_hash, never the raw code — sha256(code + phone). Short TTL, capped
-- verify attempts per row (a fresh requestOtp issues a new row with its own
-- budget rather than permanently banning the phone).
CREATE TABLE IF NOT EXISTS admission_otps (
  id          bigserial PRIMARY KEY,
  phone       text        NOT NULL,
  code_hash   text        NOT NULL,
  purpose     text        NOT NULL DEFAULT 'login',
  attempts    int         NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admission_otps_phone_created_idx ON admission_otps (phone, created_at DESC);

ALTER TABLE admission_otps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access otps" ON admission_otps;
CREATE POLICY "Full access otps" ON admission_otps FOR ALL USING (true);

-- ── SMS settings (generic outbound-webhook shape) ────────────────────────
-- {method, url, headers, bodyTemplate} — {phone}/{otp} placeholders filled
-- in before the request. Deliberately provider-agnostic: whichever BD SMS
-- API the admin wires in later plugs into this same shape without another
-- code change. Empty until configured — while empty, requestOtp returns the
-- code directly in its response instead of sending it (see app/api/apply/
-- route.js), so phone sign-in is testable before a real gateway exists.
INSERT INTO admission_settings (key, value) VALUES
('sms_settings', '{}')
ON CONFLICT (key) DO NOTHING;

-- ── Catch-up: tables/columns the live app already depends on but that were
-- never added to schema.sql, so schema.sql + this file together stay a true
-- "runs clean from scratch" reference. ────────────────────────────────────
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS applicant_email  text;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS stage            text DEFAULT 'initiated';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_status   text DEFAULT 'none';
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_method   text;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_ref      text;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS payment_amount   numeric;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS paid_at          timestamptz;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS room_no          text;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS admit_issued_at  timestamptz;
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS source           text DEFAULT 'admin';

CREATE TABLE IF NOT EXISTS admission_payments (
  id              bigserial PRIMARY KEY,
  application_id  bigint      NOT NULL,
  tran_id         text        NOT NULL UNIQUE,
  gateway         text        NOT NULL,
  amount          numeric     NOT NULL,
  currency        text        NOT NULL DEFAULT 'BDT',
  status          text        NOT NULL DEFAULT 'initiated',
  val_id          text,
  payer_ref       text,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admission_payments_application_idx ON admission_payments (application_id);

ALTER TABLE admission_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access payments" ON admission_payments;
CREATE POLICY "Full access payments" ON admission_payments FOR ALL USING (true);
