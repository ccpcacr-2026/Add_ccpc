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
('admit_card_settings', '{}')
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

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

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
