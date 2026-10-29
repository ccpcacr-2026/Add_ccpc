import { NextResponse } from 'next/server';
import crypto from 'crypto';

// ── Public applicant self-service API ────────────────────────────────────────
// Separate from /api/exec (which is admin-password gated). Applicants sign in
// (email, Google, or phone+OTP — every method issues the same session shape,
// so none of the apply logic below needs to know which one was used), pick a
// circular, and submit. Tracking and index numbers come from the same
// race-proof DB primitives the admin flow uses (atomic sequence + atomic
// per-criteria counter + UNIQUE constraints), so a number can never be
// duplicated even under simultaneous submissions.

// Tolerate a SUPABASE_URL that was pasted with a trailing /rest/v1 or slash.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_SECRET = process.env.APPLICANT_SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev-secret';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function sb(path, method = 'GET', body = null) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
      'Accept-Profile': 'admission',
      'Content-Profile': 'admission',
    },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) return { error: text, status: res.status };
  return text ? JSON.parse(text) : null;
}
async function sbRpc(fn, params = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Accept-Profile': 'admission', 'Content-Profile': 'admission' },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) return null;
  return text ? JSON.parse(text) : null;
}

// Index-ID pattern builder — identical to the admin side, so both channels
// produce numbers in the same scheme.
function buildIndexId(settings, session, cls, cat, counter) {
  const pattern    = settings.pattern || '{YY}{CLASS}{SEQ4}';
  const classCodes = settings.classCodes || {};
  const catCodes   = settings.categoryCodes || {};
  const yr = String(session || new Date().getFullYear());
  return pattern
    .replace('{YYYY}', yr)
    .replace('{YY}', yr.slice(-2))
    .replace('{CLASS}', classCodes[cls] || '')
    .replace('{CAT}', catCodes[cat] || 'X')
    .replace('{SEQ5}', String(counter || 1).padStart(5, '0'))
    .replace('{SEQ4}', String(counter || 1).padStart(4, '0'))
    .replace('{SEQ3}', String(counter || 1).padStart(3, '0'));
}

// ── Signed applicant session (base64url payload + HMAC) ──────────────────────
// Identity is either an email (email/Google sign-in) or a phone number
// (OTP sign-in) — {identity, identityType, name, exp}. identityFilter/
// identityColumns below are how every query/insert site stays agnostic to
// which one a given applicant used.
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signSession(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function readSession(req) {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)applicant_session=([^;]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  let data;
  try { data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
  if (!data.exp || Date.now() > data.exp) return null;
  // Back-compat: a cookie issued before identity/identityType existed
  // (30-day TTL, so these linger well past deploy) still just carries
  // {email, name, exp} — normalize it instead of rejecting it, or every
  // applicant who signed in last month gets silently logged out.
  if (data.email && !data.identityType) return { identity: data.email, identityType: 'email', name: data.name, exp: data.exp };
  if (!data.identity || !data.identityType) return null;
  return data;
}
function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `applicant_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}
function identityFilter(session) {
  const col = session.identityType === 'phone' ? 'applicant_phone' : 'applicant_email';
  return `${col}=eq.${encodeURIComponent(session.identity)}`;
}
function identityColumns(session) {
  return session.identityType === 'phone'
    ? { applicant_phone: session.identity }
    : { applicant_email: session.identity };
}

// ── Phone + OTP sign-in ────────────────────────────────────────────────────
// 01XXXXXXXXX or +8801XXXXXXXXX, normalized to the bare 01XXXXXXXXX form
// (the form both get stored and matched as, consistently).
function normalizePhone(raw) {
  const s = String(raw || '').trim().replace(/[\s-]/g, '');
  const m = /^(?:\+?88)?(01\d{9})$/.exec(s);
  return m ? m[1] : null;
}
function hashOtp(code, phone) {
  return crypto.createHash('sha256').update(`${code}:${phone}`).digest('hex');
}
// Generic HTTP sender — sms_settings holds {method, url, headers, bodyTemplate},
// with {phone}/{otp} placeholders filled in before the request. Deliberately
// provider-agnostic: whichever BD SMS API gets configured later plugs into
// this same shape without another code change. GET-style gateways take the
// substitution URL-encoded (already handled by the templated URL/query
// string the admin enters); POST-style gateways get it JSON-escaped via
// JSON.stringify so a stray quote in the message can't break the payload.
async function sendOtpSms(phone, code, smsSettings) {
  const s = smsSettings || {};
  if (!s.url) return { sent: false, reason: 'not_configured' };
  const message = String(s.messageTemplate || 'Your CCPC Admission verification code is {otp}').replace(/\{phone\}/g, phone).replace(/\{otp\}/g, code);
  let url = String(s.url).replace(/\{phone\}/g, encodeURIComponent(phone)).replace(/\{otp\}/g, encodeURIComponent(code)).replace(/\{message\}/g, encodeURIComponent(message));
  const method = (s.method || 'GET').toUpperCase();
  const headers = { ...(s.headers || {}) };
  let body;
  if (method !== 'GET' && s.bodyTemplate) {
    const jsonSafe = (v) => JSON.stringify(v).slice(1, -1); // escaped, without the wrapping quotes
    body = String(s.bodyTemplate).replace(/\{phone\}/g, jsonSafe(phone)).replace(/\{otp\}/g, jsonSafe(code)).replace(/\{message\}/g, jsonSafe(message));
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  }
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
    return { sent: res.ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: 'request_failed' };
  }
}

// ── Admin-editable form fields ────────────────────────────────────────────
// Canonical built-in field list — matches today's hardcoded form exactly
// (same list seeded once into admission_settings.form_fields_json by
// migration_form_fields.sql). The server reconciles whatever's actually
// stored against THIS list on every read (loadFormFields below), so a
// future code change that adds a real column can't silently vanish from
// admin control just because nobody re-ran a migration's one-time INSERT.
const BUILTIN_FORM_FIELDS = [
  { key: 'name_english', label: "Student's name (English)", type: 'text', section: 'student', required: true, visible: true, built_in: true, wide: true, placeholder: 'As per birth certificate' },
  { key: 'name_bangla', label: "Student's name (Bangla)", type: 'text', section: 'student', required: false, visible: true, built_in: true, wide: true, placeholder: 'নাম' },
  { key: 'date_of_birth', label: 'Date of birth', type: 'date', section: 'student', required: false, visible: true, built_in: true },
  { key: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'], section: 'student', required: false, visible: true, built_in: true },
  { key: 'blood_group', label: 'Blood group', type: 'text', section: 'student', required: false, visible: true, built_in: true, placeholder: 'e.g. B+' },
  { key: 'religion', label: 'Religion', type: 'text', section: 'student', required: false, visible: true, built_in: true },
  { key: 'birth_reg_no', label: 'Birth registration no.', type: 'text', section: 'student', required: false, visible: true, built_in: true },
  { key: 'nationality', label: 'Nationality', type: 'text', default: 'Bangladeshi', section: 'student', required: false, visible: true, built_in: true },
  { key: 'emergency_contact', label: 'Emergency contact no.', type: 'text', section: 'student', required: false, visible: true, built_in: true, placeholder: '+8801…' },
  { key: 'height', label: 'Height (inch)', type: 'text', section: 'student', required: false, visible: true, built_in: true },
  { key: 'last_class', label: 'Last class', type: 'text', section: 'student', required: false, visible: true, built_in: true },
  { key: 'last_version', label: 'Last version', type: 'text', section: 'student', required: false, visible: true, built_in: true },
  { key: 'last_institute', label: 'Last institute', type: 'text', section: 'student', required: false, visible: true, built_in: true, wide: true },
  { key: 'present_address', label: 'Present address', type: 'textarea', section: 'student', required: false, visible: true, built_in: true, wide: true },
  { key: 'permanent_address', label: 'Permanent address', type: 'textarea', section: 'student', required: false, visible: true, built_in: true, wide: true },
  { key: 'co_curricular', label: 'Co-curricular activities', type: 'text', section: 'student', required: false, visible: true, built_in: true, wide: true, placeholder: 'e.g. Football, Drawing, Singing' },
  { key: 'student_photo', label: "Student's photo", type: 'photo', section: 'student', required: true, visible: true, built_in: true, wide: true },

  { key: 'father_name', label: "Father's name", type: 'text', section: 'father', required: false, visible: true, built_in: true },
  { key: 'father_profession', label: 'Profession / occupation', type: 'text', section: 'father', required: false, visible: true, built_in: true },
  { key: 'father_designation', label: 'Designation / rank', type: 'text', section: 'father', required: false, visible: true, built_in: true },
  { key: 'father_education', label: 'Education', type: 'text', section: 'father', required: false, visible: true, built_in: true },
  { key: 'father_contact', label: 'Contact no.', type: 'text', section: 'father', required: false, visible: true, built_in: true },
  { key: 'father_nid', label: 'NID', type: 'text', section: 'father', required: false, visible: true, built_in: true },
  { key: 'father_office_address', label: 'Office address / unit', type: 'text', section: 'father', required: false, visible: true, built_in: true, wide: true },
  { key: 'father_yearly_income', label: 'Yearly income', type: 'text', section: 'father', required: false, visible: true, built_in: true },
  { key: 'father_photo', label: "Father's photo", type: 'photo', section: 'father', required: false, visible: true, built_in: true, wide: true },

  { key: 'mother_name', label: "Mother's name", type: 'text', section: 'mother', required: false, visible: true, built_in: true },
  { key: 'mother_profession', label: 'Profession / occupation', type: 'text', section: 'mother', required: false, visible: true, built_in: true },
  { key: 'mother_designation', label: 'Designation / rank', type: 'text', section: 'mother', required: false, visible: true, built_in: true },
  { key: 'mother_education', label: 'Education', type: 'text', section: 'mother', required: false, visible: true, built_in: true },
  { key: 'mother_contact', label: 'Contact no.', type: 'text', section: 'mother', required: false, visible: true, built_in: true },
  { key: 'mother_nid', label: 'NID', type: 'text', section: 'mother', required: false, visible: true, built_in: true },
  { key: 'mother_office_address', label: 'Office address / unit', type: 'text', section: 'mother', required: false, visible: true, built_in: true, wide: true },
  { key: 'mother_yearly_income', label: 'Yearly income', type: 'text', section: 'mother', required: false, visible: true, built_in: true },
  { key: 'mother_photo', label: "Mother's photo", type: 'photo', section: 'mother', required: false, visible: true, built_in: true, wide: true },

  { key: 'guardian_name', label: "Guardian's name", type: 'text', section: 'guardian', required: false, visible: true, built_in: true },
  { key: 'guardian_relation', label: 'Relation', type: 'text', section: 'guardian', required: false, visible: true, built_in: true, placeholder: 'e.g. Father' },
  { key: 'guardian_profession', label: 'Profession / occupation', type: 'text', section: 'guardian', required: false, visible: true, built_in: true },
  { key: 'guardian_designation', label: 'Designation / rank', type: 'text', section: 'guardian', required: false, visible: true, built_in: true },
  { key: 'guardian_education', label: 'Education', type: 'text', section: 'guardian', required: false, visible: true, built_in: true },
  { key: 'guardian_contact', label: 'Contact no.', type: 'text', section: 'guardian', required: false, visible: true, built_in: true },
  { key: 'guardian_office_address', label: 'Office address / unit', type: 'text', section: 'guardian', required: false, visible: true, built_in: true, wide: true },
  { key: 'guardian_nid', label: 'Guardian NID', type: 'text', section: 'guardian', required: false, visible: false, built_in: true },
  { key: 'guardian_photo', label: "Guardian's photo", type: 'photo', section: 'guardian', required: false, visible: true, built_in: true, wide: true },
];
function reconcileFormFields(stored) {
  const list = Array.isArray(stored) ? stored.slice() : [];
  const seen = new Set(list.map(f => f && f.key));
  BUILTIN_FORM_FIELDS.forEach(def => { if (!seen.has(def.key)) list.push({ ...def }); });
  return list;
}
async function loadFormFields() {
  const rows = await sb('admission_settings?key=eq.form_fields_json');
  const stored = (Array.isArray(rows) && rows[0]) ? rows[0].value : [];
  return reconcileFormFields(stored);
}
// Built-in keys write to a real column; everything else (admin-added
// custom fields) routes into the extra_fields JSONB column instead —
// never an arbitrary client-supplied key either way (no status/
// tracking_id/index_id/source injection).
function allowedBuiltInKeys(fields) { return new Set(fields.filter(f => f.built_in).map(f => f.key)); }
function allowedCustomKeys(fields) { return new Set(fields.filter(f => !f.built_in).map(f => f.key)); }

// Which bucket folder each photo field lands in (bucket "applicants" has
// folders father / mother / applicants; student + guardian go under applicants).
const PHOTO_FOLDER = {
  student_photo: 'applicants', father_photo: 'father', mother_photo: 'mother', guardian_photo: 'applicants',
};

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { action, payload = {} } = body;

  // ── Config: choices for the application form ────────────────────────────────
  // The circular (add-class model) decides which classes are OPEN and, per class,
  // which versions/categories are allowed. Applicants can only pick open combos.
  // If no circular classes are configured yet, fall back to every defined class.
  if (action === 'config') {
    const rows = await sb(`admission_settings?key=in.(index_settings,circular_settings,form_fields_json)`);
    const arr = (rows && !rows.error && Array.isArray(rows)) ? rows : [];
    const idx  = (arr.find(r => r.key === 'index_settings')    || {}).value || {};
    const circ = (arr.find(r => r.key === 'circular_settings') || {}).value || {};
    const formFields = reconcileFormFields((arr.find(r => r.key === 'form_fields_json') || {}).value)
      .filter(f => f.visible !== false);
    const allClasses    = Object.keys(idx.classCodes || {});
    const allCategories = Object.keys(idx.categoryCodes || {});
    const openClasses = Array.isArray(circ.classes) ? circ.classes.filter(c => c && c.class) : [];
    let classes, byClass = {};
    if (openClasses.length) {
      classes = openClasses.map(c => c.class);
      openClasses.forEach(c => {
        byClass[c.class] = {
          versions:   (Array.isArray(c.versions)   && c.versions.length)   ? c.versions   : ['Bangla', 'English'],
          categories: (Array.isArray(c.categories) && c.categories.length) ? c.categories : allCategories,
          seats: c.seats || '',
        };
      });
    } else {
      classes = allClasses;
      allClasses.forEach(c => { byClass[c] = { versions: ['Bangla', 'English'], categories: allCategories, seats: '' }; });
    }
    // The session an applicant can pick is the circular's own configured
    // session, never today's calendar year — a circular opened in one year
    // is routinely for the next intake year. Only fall back to "this year /
    // next year" when no circular session has been set up yet at all.
    const year = new Date().getFullYear();
    const sessions = circ.session ? [String(circ.session)] : [String(year), String(year + 1)];
    return NextResponse.json({
      classes, byClass,
      categories: allCategories,
      sessions,
      open: openClasses.length > 0,
      circularTitle: circ.title || '',
      circularSession: circ.session || '',
      startDate: circ.startDate || '', endDate: circ.endDate || '',
      formFields,
    });
  }

  // ── Sign in (email). Google will replace this with a verified identity. ─────
  if (action === 'login') {
    const email = String(payload.email || '').trim().toLowerCase();
    const name = String(payload.name || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' });
    }
    const token = signSession({ identity: email, identityType: 'email', name, exp: Date.now() + SESSION_TTL_MS });
    return NextResponse.json({ email, name }, { headers: { 'Set-Cookie': sessionCookie(token) } });
  }

  if (action === 'me') {
    const s = readSession(req);
    return NextResponse.json({
      authed: !!s,
      identity: s?.identity || null,
      identityType: s?.identityType || null,
      email: (s && s.identityType === 'email') ? s.identity : null,
      phone: (s && s.identityType === 'phone') ? s.identity : null,
      name: s?.name || null,
    });
  }

  // ── Google sign-in ──────────────────────────────────────────────────────────
  // The frontend uses Google Identity Services (the one-tap / "Sign in with
  // Google" picker that surfaces the accounts the user is already logged into).
  // It returns a signed ID token; we verify it with Google (audience must match
  // our client id, email must be verified), then issue the same session cookie
  // as email login. Only a GOOGLE_CLIENT_ID is needed — no client secret.
  if (action === 'googleConfig') {
    return NextResponse.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
  }
  if (action === 'googleLogin') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const credential = payload.credential;
    if (!clientId) return NextResponse.json({ error: 'Google sign-in is not configured yet.' }, { status: 400 });
    if (!credential) return NextResponse.json({ error: 'Missing Google credential.' }, { status: 400 });
    let info = null;
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const c = await r.json();
        const issOk = c.iss === 'accounts.google.com' || c.iss === 'https://accounts.google.com';
        const emailOk = c.email_verified === true || c.email_verified === 'true';
        if (c.aud === clientId && issOk && emailOk && c.email) {
          info = { email: String(c.email).toLowerCase(), name: c.name || c.given_name || '' };
        }
      }
    } catch (_) { /* falls through to error */ }
    if (!info) return NextResponse.json({ error: 'Could not verify your Google sign-in. Please try again.' }, { status: 401 });
    const token = signSession({ identity: info.email, identityType: 'email', name: info.name, exp: Date.now() + SESSION_TTL_MS });
    return NextResponse.json({ email: info.email, name: info.name }, { headers: { 'Set-Cookie': sessionCookie(token) } });
  }

  // ── Phone + OTP sign-in ──────────────────────────────────────────────────
  // Two-tier rate limit: refuse within 60s of the last request (stops
  // rapid-fire), and refuse past 5 requests in 24h for the same phone (stops
  // sustained abuse — once a real SMS gateway is wired in, every request has
  // a real cost). While sms_settings isn't configured, the code comes back
  // directly in the response (devCode) instead of being sent, so phone
  // sign-in is testable before a real SMS account exists — the admin SMS
  // settings tab shows a persistent warning while this is the case, since
  // unlike the payment module's manual fallback, devCode mode means no
  // verification is actually happening at all.
  if (action === 'requestOtp') {
    const phone = normalizePhone(payload.phone);
    if (!phone) return NextResponse.json({ error: 'Enter a valid Bangladeshi mobile number.' });
    const recent = await sb(`admission_otps?phone=eq.${encodeURIComponent(phone)}&select=created_at&order=created_at.desc&limit=1`);
    const last = (Array.isArray(recent) && recent[0]) ? new Date(recent[0].created_at).getTime() : 0;
    if (last && Date.now() - last < 60 * 1000) {
      return NextResponse.json({ error: 'Please wait a moment before requesting another code.' });
    }
    const dayCount = await sb(`admission_otps?phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}&select=id`);
    if (Array.isArray(dayCount) && dayCount.length >= 5) {
      return NextResponse.json({ error: 'Too many codes requested for this number today. Try again tomorrow.' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const ins = await sb('admission_otps', 'POST', {
      phone, code_hash: hashOtp(code, phone), purpose: 'login',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    if (ins && ins.error) return NextResponse.json({ error: 'Could not send a code. Try again.' });

    const settingsRows = await sb(`admission_settings?key=eq.sms_settings`);
    const smsSettings = (Array.isArray(settingsRows) && settingsRows[0]) ? settingsRows[0].value : {};
    if (!smsSettings || !smsSettings.url) {
      return NextResponse.json({ sent: true, devCode: code });
    }
    const result = await sendOtpSms(phone, code, smsSettings);
    if (!result.sent) return NextResponse.json({ error: 'Could not send the code. Please try again shortly.' });
    return NextResponse.json({ sent: true });
  }

  if (action === 'verifyOtp') {
    const phone = normalizePhone(payload.phone);
    const code = String(payload.code || '').trim();
    if (!phone || !code) return NextResponse.json({ error: 'Enter the phone number and the code.' });
    const rows = await sb(`admission_otps?phone=eq.${encodeURIComponent(phone)}&verified_at=is.null&expires_at=gte.${encodeURIComponent(new Date().toISOString())}&select=*&order=created_at.desc&limit=1`);
    const row = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
    if (!row) return NextResponse.json({ error: 'That code has expired. Request a new one.' });
    if (row.attempts >= 5) return NextResponse.json({ error: 'Too many incorrect attempts. Request a new code.' });
    if (hashOtp(code, phone) !== row.code_hash) {
      await sb(`admission_otps?id=eq.${row.id}`, 'PATCH', { attempts: row.attempts + 1 });
      return NextResponse.json({ error: 'Incorrect code. Please try again.' });
    }
    await sb(`admission_otps?id=eq.${row.id}`, 'PATCH', { verified_at: new Date().toISOString() });
    const name = String(payload.name || '').trim();
    const token = signSession({ identity: phone, identityType: 'phone', name, exp: Date.now() + SESSION_TTL_MS });
    return NextResponse.json({ phone, name }, { headers: { 'Set-Cookie': sessionCookie(token) } });
  }

  if (action === 'logout') {
    return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': 'applicant_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' } });
  }

  // ── Photo upload → Supabase Storage bucket "applicants" ─────────────────────
  // Client sends a base64 image (already resized/compressed to ≤130 KB). We
  // upload it server-side with the service key and return the public URL to
  // store on the application row. Enforces the field→folder map, size, and
  // image mime — matching the bucket's own limits (public, image/*, 130 KB).
  if (action === 'uploadPhoto') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
    const { field, dataUrl } = payload;
    const folder = PHOTO_FOLDER[field];
    if (!folder) return NextResponse.json({ error: 'Unknown photo field.' }, { status: 400 });
    const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!m) return NextResponse.json({ error: 'Please choose a JPG, PNG or WebP image.' }, { status: 400 });
    const contentType = m[1];
    const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 130 * 1024) return NextResponse.json({ error: 'Image is over 130 KB even after compression — pick a smaller photo.' }, { status: 400 });
    const safe = String(session.identity).replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const path = `${folder}/${safe}-${field}-${Date.now()}.${ext}`;
    const up = await fetch(`${SB_URL}/storage/v1/object/applicants/${path}`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buf,
    });
    if (!up.ok) {
      const t = await up.text();
      return NextResponse.json({ error: 'Upload failed. Try again.', detail: t.slice(0, 120) }, { status: 502 });
    }
    return NextResponse.json({ success: true, url: `${SB_URL}/storage/v1/object/public/applicants/${path}` });
  }

  // ── STEP 1: Initiate an application ─────────────────────────────────────────
  // The applicant picks class/version/category first; this mints the tracking
  // and index numbers immediately (same race-proof primitives as submit) and
  // creates the row in stage 'initiated'. The rest of the form is filled at
  // leisure via saveDraft, then locked by submitFinal.
  if (action === 'initiate') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });

    const pick = {
      session: String(payload.session || '').trim(),
      class: String(payload.class || '').trim(),
      version: String(payload.version || '').trim(),
      category: String(payload.category || '').trim(),
      quota: String(payload.quota || 'No').trim() || 'No',
    };
    if (!pick.session || !pick.class || !pick.version || !pick.category) {
      return NextResponse.json({ error: 'Pick session, class, version and category first.' });
    }

    // Validate against what the circular opened (fallback: any defined class).
    const setRows = await sb(`admission_settings?key=in.(index_settings,circular_settings)`);
    const setArr = (setRows && !setRows.error && Array.isArray(setRows)) ? setRows : [];
    const idxSettings = (setArr.find(r => r.key === 'index_settings') || {}).value || {};
    const circ = (setArr.find(r => r.key === 'circular_settings') || {}).value || {};
    const openClasses = Array.isArray(circ.classes) ? circ.classes.filter(c => c && c.class) : [];
    if (openClasses.length) {
      const cls = openClasses.find(c => c.class === pick.class);
      if (!cls) return NextResponse.json({ error: `Class ${pick.class} is not open in the current circular.` });
      const versions = (Array.isArray(cls.versions) && cls.versions.length) ? cls.versions : ['Bangla', 'English'];
      const categories = (Array.isArray(cls.categories) && cls.categories.length) ? cls.categories : Object.keys(idxSettings.categoryCodes || {});
      if (!versions.includes(pick.version)) return NextResponse.json({ error: `${pick.version} version is not open for ${pick.class}.` });
      if (!categories.includes(pick.category)) return NextResponse.json({ error: `${pick.category} category is not open for ${pick.class}.` });
    } else if (!(pick.class in (idxSettings.classCodes || {}))) {
      return NextResponse.json({ error: 'Unknown class.' });
    }

    // One live application per exact combo per account — a double-click or
    // re-visit resumes the existing one instead of minting a fresh index.
    const dupQ = `admission_applications?${identityFilter(session)}` +
      `&session=eq.${encodeURIComponent(pick.session)}&class=eq.${encodeURIComponent(pick.class)}` +
      `&version=eq.${encodeURIComponent(pick.version)}&category=eq.${encodeURIComponent(pick.category)}` +
      `&select=id,tracking_id,index_id,stage,payment_status&order=created_at.desc&limit=1`;
    const dup = await sb(dupQ);
    if (Array.isArray(dup) && dup.length) {
      return NextResponse.json({ success: true, existing: true, ...dup[0] });
    }

    const year = String(pick.session || new Date().getFullYear());
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const trackingId = await sbRpc('generate_tracking_id', {});
      if (!trackingId) { lastErr = 'Could not generate a tracking number.'; continue; }
      const counter = await sbRpc('increment_index_counter', { p_year: year, p_class: pick.class });
      if (counter == null) { lastErr = 'Could not generate an index number.'; continue; }
      const row = {
        ...pick,
        tracking_id: trackingId,
        index_id: buildIndexId(idxSettings, pick.session, pick.class, pick.category, counter),
        ...identityColumns(session),
        source: 'applicant',
        status: 'Pending',
        stage: 'initiated',
        payment_status: 'none',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const res = await sb('admission_applications', 'POST', row);
      if (res && res.error) {
        if (/23505|duplicate key|unique/i.test(String(res.error))) { lastErr = res.error; continue; }
        return NextResponse.json({ error: 'Could not start your application. Please try again.' });
      }
      return NextResponse.json({ success: true, id: res?.[0]?.id, tracking_id: trackingId, index_id: row.index_id, stage: 'initiated' });
    }
    return NextResponse.json({ error: 'Could not assign a unique number after several tries. Please retry.', detail: String(lastErr || '') });
  }

  // ── STEP 2: Save progress on an initiated application ───────────────────────
  if (action === 'saveDraft') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
    const id = parseInt(payload.id, 10);
    if (!id) return NextResponse.json({ error: 'Missing application id.' });
    const form = payload.data || {};
    const LOCKED = new Set(['session', 'class', 'category', 'version', 'quota']); // fixed at initiate
    const fields = await loadFormFields();
    const builtInKeys = allowedBuiltInKeys(fields);
    const customKeys = allowedCustomKeys(fields);
    const data = {};
    const extra = {};
    for (const k of Object.keys(form)) {
      if (LOCKED.has(k)) continue;
      if (builtInKeys.has(k)) data[k] = form[k];
      else if (customKeys.has(k)) extra[k] = form[k];
      // any other key (unknown/stale) is silently dropped — never trusted.
    }
    // The client sweeps every field's current value on every save (not an
    // incremental diff), so this is a full replacement of extra_fields, not
    // a read-merge-write — no lost-update race to guard against.
    if (customKeys.size) data.extra_fields = extra;
    data.updated_at = new Date().toISOString();
    const q = `admission_applications?id=eq.${id}&${identityFilter(session)}&stage=eq.initiated`;
    const res = await fetch(`${SB_URL}/rest/v1/${q}`, {
      method: 'PATCH',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', 'Accept-Profile': 'admission', 'Content-Profile': 'admission' },
      body: JSON.stringify(data),
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: 'Could not save. Try again.' });
    const rows = text ? JSON.parse(text) : [];
    if (!Array.isArray(rows) || !rows.length) return NextResponse.json({ error: 'This application is already submitted — it can no longer be edited.' });
    return NextResponse.json({ success: true, saved_at: data.updated_at });
  }

  // ── STEP 3: Final submit (locks the form) ───────────────────────────────────
  if (action === 'submitFinal') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
    const id = parseInt(payload.id, 10);
    if (!id) return NextResponse.json({ error: 'Missing application id.' });
    const rows = await sb(`admission_applications?id=eq.${id}&${identityFilter(session)}&select=*`);
    const app = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
    if (!app) return NextResponse.json({ error: 'Application not found.' });
    if (app.stage !== 'initiated') return NextResponse.json({ error: 'This application is already submitted.' });
    const fields = await loadFormFields();
    const extra = app.extra_fields || {};
    const isEmpty = v => v == null || String(v).trim() === '';
    const missing = fields
      .filter(f => f.required && f.visible !== false)
      .filter(f => isEmpty(f.built_in ? app[f.key] : extra[f.key]))
      .map(f => f.label);
    if (missing.length) return NextResponse.json({ error: 'Please complete before submitting: ' + missing.join(', ') + '. (Use Save progress first.)' });
    const upd = await fetch(`${SB_URL}/rest/v1/admission_applications?id=eq.${id}&${identityFilter(session)}&stage=eq.initiated`, {
      method: 'PATCH',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', 'Accept-Profile': 'admission', 'Content-Profile': 'admission' },
      body: JSON.stringify({ stage: 'submitted', updated_at: new Date().toISOString() }),
    });
    const utext = await upd.text();
    const urows = upd.ok && utext ? JSON.parse(utext) : [];
    if (!Array.isArray(urows) || !urows.length) return NextResponse.json({ error: 'Could not submit. Try again.' });
    return NextResponse.json({ success: true, stage: 'submitted' });
  }

  // ── STEP 4 helper: what does this applicant owe, and how can they pay? ──────
  if (action === 'payInfo') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
    const id = parseInt(payload.id, 10);
    if (!id) return NextResponse.json({ error: 'Missing application id.' });
    const rows = await sb(`admission_applications?id=eq.${id}&${identityFilter(session)}&select=id,class,stage,payment_status,payment_amount,paid_at,tracking_id`);
    const app = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
    if (!app) return NextResponse.json({ error: 'Application not found.' });
    const setRows = await sb(`admission_settings?key=in.(payment_settings,circular_settings)`);
    const setArr = (setRows && !setRows.error && Array.isArray(setRows)) ? setRows : [];
    const pay = (setArr.find(r => r.key === 'payment_settings') || {}).value || {};
    const circ = (setArr.find(r => r.key === 'circular_settings') || {}).value || {};
    const circCls = (Array.isArray(circ.classes) ? circ.classes : []).find(c => c && c.class === app.class);
    const fee = Number(circCls && circCls.fee) || Number(pay.defaultFee) || 0;
    const gatewayReady = !!(pay.sslStoreId && pay.sslStorePass && pay.gatewayEnabled !== false);
    return NextResponse.json({
      stage: app.stage, payment_status: app.payment_status, paid_at: app.paid_at,
      fee, currency: pay.currency || 'BDT',
      gateway: gatewayReady,
      sandbox: pay.sslSandbox !== false,
      manual: pay.manualEnabled !== false,
      manualNumbers: pay.manualNumbers || '',
      manualInstructions: pay.manualInstructions || '',
    });
  }

  // ── STEP 5: data for the printable form / admit card ────────────────────────
  if (action === 'printData') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
    const id = parseInt(payload.id, 10);
    const type = payload.type === 'admit' ? 'admit' : 'form';
    if (!id) return NextResponse.json({ error: 'Missing application id.' });
    const rows = await sb(`admission_applications?id=eq.${id}&${identityFilter(session)}&select=*`);
    const app = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
    if (!app) return NextResponse.json({ error: 'Application not found.' });
    if (type === 'form' && app.payment_status !== 'verified') {
      return NextResponse.json({ error: 'The application form unlocks after your payment is confirmed.' });
    }
    if (type === 'admit' && !app.room_no) {
      return NextResponse.json({ error: 'Your admit card has not been issued yet.' });
    }
    const setRows = await sb(`admission_settings?key=in.(form_settings,form_templates,admit_card_settings,admit_templates)`);
    const settings = {};
    if (setRows && !setRows.error && Array.isArray(setRows)) for (const r of setRows) settings[r.key] = r.value;
    return NextResponse.json({ application: app, settings });
  }

  // ── Submit an application (legacy single-shot; superseded by initiate flow) ──
  if (action === 'submit') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });

    const form = payload.data || {};
    if (!form.name_english || !form.class || !form.session) {
      return NextResponse.json({ error: 'Name, class and session are required.' });
    }

    // Whitelist the fields the applicant may set (built-in only — this path
    // is legacy/superseded, not worth extending to admin-added custom fields).
    const builtInKeys = new Set(BUILTIN_FORM_FIELDS.map(f => f.key));
    const data = {};
    for (const k of Object.keys(form)) if (builtInKeys.has(k)) data[k] = form[k];
    Object.assign(data, identityColumns(session));
    data.source = 'applicant';
    data.status = 'Pending';
    data.created_at = new Date().toISOString();
    data.updated_at = data.created_at;

    const settingsRows = await sb(`admission_settings?key=eq.index_settings`);
    const indexSettings = (settingsRows && !settingsRows.error && settingsRows[0]) ? settingsRows[0].value : {};
    const year = String(data.session || new Date().getFullYear());
    const counterKey = data.class || '';

    // Try a few times — the sequence + atomic counter make collisions
    // essentially impossible, and the UNIQUE constraints are the hard backstop,
    // so a rare conflict self-heals by re-drawing fresh numbers.
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const trackingId = await sbRpc('generate_tracking_id', {});
      if (!trackingId) { lastErr = 'Could not generate a tracking number.'; continue; }
      const counter = await sbRpc('increment_index_counter', { p_year: year, p_class: counterKey });
      if (counter == null) { lastErr = 'Could not generate an index number.'; continue; }
      const row = { ...data, tracking_id: trackingId, index_id: buildIndexId(indexSettings, data.session, data.class, data.category, counter) };
      const res = await sb('admission_applications', 'POST', row);
      if (res && res.error) {
        // 23505 = unique_violation → a number clashed; loop to redraw.
        if (/23505|duplicate key|unique/i.test(String(res.error))) { lastErr = res.error; continue; }
        return NextResponse.json({ error: 'Could not submit your application. Please try again.' });
      }
      return NextResponse.json({
        success: true,
        id: res?.[0]?.id,
        tracking_id: trackingId,
        index_id: row.index_id,
      });
    }
    return NextResponse.json({ error: 'Could not assign a unique number after several tries. Please retry.', detail: String(lastErr || '') });
  }

  // ── This applicant's own applications ───────────────────────────────────────
  if (action === 'myApplications') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });
    // Full rows: the client needs every field to resume an in-progress draft.
    const rows = await sb(`admission_applications?${identityFilter(session)}&select=*&order=created_at.desc`);
    return NextResponse.json({ applications: (rows && !rows.error) ? rows : [] });
  }

  // ── Public status lookup by tracking number (no sign-in needed) ─────────────
  if (action === 'track') {
    const t = String(payload.tracking_id || '').trim().toUpperCase();
    if (!t) return NextResponse.json({ error: 'Enter a tracking number.' });
    const rows = await sb(`admission_applications?tracking_id=eq.${encodeURIComponent(t)}&select=tracking_id,index_id,name_english,class,session,status,stage,payment_status,room_no,admit_issued_at`);
    const app = (rows && !rows.error && rows[0]) ? rows[0] : null;
    if (!app) return NextResponse.json({ found: false });
    return NextResponse.json({ found: true, application: app });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
