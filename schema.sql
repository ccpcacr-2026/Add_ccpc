-- CCPC Admission Applications
CREATE TABLE IF NOT EXISTS admission_applications (
  id            BIGSERIAL PRIMARY KEY,
  tracking_id   TEXT UNIQUE,
  index_id      TEXT,
  session       TEXT,
  class         TEXT,
  category      TEXT,   -- Army / Civil / Defence / CCPC Teacher / Staff
  version       TEXT,   -- Bangla / English
  quota         TEXT DEFAULT 'No',
  status        TEXT DEFAULT 'Pending',

  -- Student
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

  -- Father
  father_name          TEXT,
  father_profession    TEXT,
  father_designation   TEXT,
  father_education     TEXT,
  father_contact       TEXT,
  father_nid           TEXT,
  father_office_address TEXT,
  father_yearly_income TEXT,
  father_photo         TEXT,

  -- Mother
  mother_name          TEXT,
  mother_profession    TEXT,
  mother_designation   TEXT,
  mother_education     TEXT,
  mother_contact       TEXT,
  mother_nid           TEXT,
  mother_office_address TEXT,
  mother_yearly_income TEXT,
  mother_photo         TEXT,

  -- Local Guardian
  guardian_name          TEXT,
  guardian_profession    TEXT,
  guardian_designation   TEXT,
  guardian_education     TEXT,
  guardian_contact       TEXT,
  guardian_relation      TEXT,
  guardian_office_address TEXT,
  guardian_photo         TEXT,

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admission_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access admission" ON admission_applications;
CREATE POLICY "Full access admission" ON admission_applications FOR ALL USING (true);
