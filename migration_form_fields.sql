-- ═══════════════════════════════════════════════════════
-- CCPC Admission — Admin-editable "fill in" form fields
-- Run in Supabase SQL editor
-- ═══════════════════════════════════════════════════════

-- ── Custom (admin-added) field answers ───────────────────────────────────
-- Built-in fields (the existing ~35-column set) keep living as real
-- columns; a field the admin adds from the Form Fields tab has nowhere to
-- live in a fixed column, so it's stored here instead, keyed by its own
-- generated key. Same shape already proven on this table — see
-- academic_records/siblings below.
ALTER TABLE admission_applications ADD COLUMN IF NOT EXISTS extra_fields JSONB DEFAULT '{}';

-- ── Form field definitions (order, label, section, required, visible) ───
-- Seeded to exactly match today's hardcoded apply.html form, so nothing
-- changes in behavior until an admin actually edits something in the new
-- Form Fields tab. guardian_nid is already a real column (see schema.sql)
-- but was never rendered on the form -- seeded visible:false to preserve
-- that. The server reconciles this list against a canonical built-in list
-- on every read, so a future code change that adds a real column won't
-- silently vanish from admin control.
INSERT INTO admission_settings (key, value) VALUES
('form_fields_json', '[
  {"key":"name_english","label":"Student''s name (English)","type":"text","section":"student","required":true,"visible":true,"built_in":true,"wide":true,"placeholder":"As per birth certificate"},
  {"key":"name_bangla","label":"Student''s name (Bangla)","type":"text","section":"student","required":false,"visible":true,"built_in":true,"wide":true,"placeholder":"নাম"},
  {"key":"date_of_birth","label":"Date of birth","type":"date","section":"student","required":false,"visible":true,"built_in":true},
  {"key":"gender","label":"Gender","type":"select","options":["Male","Female","Other"],"section":"student","required":false,"visible":true,"built_in":true},
  {"key":"blood_group","label":"Blood group","type":"text","section":"student","required":false,"visible":true,"built_in":true,"placeholder":"e.g. B+"},
  {"key":"religion","label":"Religion","type":"text","section":"student","required":false,"visible":true,"built_in":true},
  {"key":"birth_reg_no","label":"Birth registration no.","type":"text","section":"student","required":false,"visible":true,"built_in":true},
  {"key":"nationality","label":"Nationality","type":"text","default":"Bangladeshi","section":"student","required":false,"visible":true,"built_in":true},
  {"key":"emergency_contact","label":"Emergency contact no.","type":"text","section":"student","required":false,"visible":true,"built_in":true,"placeholder":"+8801…"},
  {"key":"height","label":"Height (inch)","type":"text","section":"student","required":false,"visible":true,"built_in":true},
  {"key":"last_class","label":"Last class","type":"text","section":"student","required":false,"visible":true,"built_in":true},
  {"key":"last_version","label":"Last version","type":"text","section":"student","required":false,"visible":true,"built_in":true},
  {"key":"last_institute","label":"Last institute","type":"text","section":"student","required":false,"visible":true,"built_in":true,"wide":true},
  {"key":"present_address","label":"Present address","type":"textarea","section":"student","required":false,"visible":true,"built_in":true,"wide":true},
  {"key":"permanent_address","label":"Permanent address","type":"textarea","section":"student","required":false,"visible":true,"built_in":true,"wide":true},
  {"key":"co_curricular","label":"Co-curricular activities","type":"text","section":"student","required":false,"visible":true,"built_in":true,"wide":true,"placeholder":"e.g. Football, Drawing, Singing"},
  {"key":"student_photo","label":"Student''s photo","type":"photo","section":"student","required":true,"visible":true,"built_in":true,"wide":true},

  {"key":"father_name","label":"Father''s name","type":"text","section":"father","required":false,"visible":true,"built_in":true},
  {"key":"father_profession","label":"Profession / occupation","type":"text","section":"father","required":false,"visible":true,"built_in":true},
  {"key":"father_designation","label":"Designation / rank","type":"text","section":"father","required":false,"visible":true,"built_in":true},
  {"key":"father_education","label":"Education","type":"text","section":"father","required":false,"visible":true,"built_in":true},
  {"key":"father_contact","label":"Contact no.","type":"text","section":"father","required":false,"visible":true,"built_in":true},
  {"key":"father_nid","label":"NID","type":"text","section":"father","required":false,"visible":true,"built_in":true},
  {"key":"father_office_address","label":"Office address / unit","type":"text","section":"father","required":false,"visible":true,"built_in":true,"wide":true},
  {"key":"father_yearly_income","label":"Yearly income","type":"text","section":"father","required":false,"visible":true,"built_in":true},
  {"key":"father_photo","label":"Father''s photo","type":"photo","section":"father","required":false,"visible":true,"built_in":true,"wide":true},

  {"key":"mother_name","label":"Mother''s name","type":"text","section":"mother","required":false,"visible":true,"built_in":true},
  {"key":"mother_profession","label":"Profession / occupation","type":"text","section":"mother","required":false,"visible":true,"built_in":true},
  {"key":"mother_designation","label":"Designation / rank","type":"text","section":"mother","required":false,"visible":true,"built_in":true},
  {"key":"mother_education","label":"Education","type":"text","section":"mother","required":false,"visible":true,"built_in":true},
  {"key":"mother_contact","label":"Contact no.","type":"text","section":"mother","required":false,"visible":true,"built_in":true},
  {"key":"mother_nid","label":"NID","type":"text","section":"mother","required":false,"visible":true,"built_in":true},
  {"key":"mother_office_address","label":"Office address / unit","type":"text","section":"mother","required":false,"visible":true,"built_in":true,"wide":true},
  {"key":"mother_yearly_income","label":"Yearly income","type":"text","section":"mother","required":false,"visible":true,"built_in":true},
  {"key":"mother_photo","label":"Mother''s photo","type":"photo","section":"mother","required":false,"visible":true,"built_in":true,"wide":true},

  {"key":"guardian_name","label":"Guardian''s name","type":"text","section":"guardian","required":false,"visible":true,"built_in":true},
  {"key":"guardian_relation","label":"Relation","type":"text","section":"guardian","required":false,"visible":true,"built_in":true,"placeholder":"e.g. Father"},
  {"key":"guardian_profession","label":"Profession / occupation","type":"text","section":"guardian","required":false,"visible":true,"built_in":true},
  {"key":"guardian_designation","label":"Designation / rank","type":"text","section":"guardian","required":false,"visible":true,"built_in":true},
  {"key":"guardian_education","label":"Education","type":"text","section":"guardian","required":false,"visible":true,"built_in":true},
  {"key":"guardian_contact","label":"Contact no.","type":"text","section":"guardian","required":false,"visible":true,"built_in":true},
  {"key":"guardian_office_address","label":"Office address / unit","type":"text","section":"guardian","required":false,"visible":true,"built_in":true,"wide":true},
  {"key":"guardian_nid","label":"Guardian NID","type":"text","section":"guardian","required":false,"visible":false,"built_in":true},
  {"key":"guardian_photo","label":"Guardian''s photo","type":"photo","section":"guardian","required":false,"visible":true,"built_in":true,"wide":true}
]')
ON CONFLICT (key) DO NOTHING;
