import { NextResponse } from 'next/server';
import crypto from 'crypto';

// ── Public applicant self-service API ────────────────────────────────────────
// Separate from /api/exec (which is admin-password gated). Applicants sign in
// (email now; Google later — the session shape is identical so Google slots in
// without touching the apply logic), pick a circular, and submit. Tracking and
// index numbers come from the same race-proof DB primitives the admin flow uses
// (atomic sequence + atomic per-criteria counter + UNIQUE constraints), so a
// number can never be duplicated even under simultaneous submissions.

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
function buildIndexId(settings, session, cls, counter) {
  const pattern    = settings.pattern || '{YY}{CLASS}{SEQ4}';
  const classCodes = settings.classCodes || {};
  const catCodes   = settings.categoryCodes || {};
  const yr = String(session || new Date().getFullYear());
  return pattern
    .replace('{YYYY}', yr)
    .replace('{YY}', yr.slice(-2))
    .replace('{CLASS}', classCodes[cls] || '')
    .replace('{CAT}', catCodes[cls] || 'X')
    .replace('{SEQ5}', String(counter || 1).padStart(5, '0'))
    .replace('{SEQ4}', String(counter || 1).padStart(4, '0'))
    .replace('{SEQ3}', String(counter || 1).padStart(3, '0'));
}

// ── Signed applicant session (base64url payload + HMAC) ──────────────────────
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
  if (!data.email || !data.exp || Date.now() > data.exp) return null;
  return data;
}
function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `applicant_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

// Fields an applicant is allowed to set — never trust arbitrary columns from the
// client (no status/tracking_id/index_id/source injection).
const ALLOWED_FIELDS = new Set([
  'session', 'class', 'category', 'version', 'quota', 'nationality',
  'name_english', 'name_bangla', 'date_of_birth', 'blood_group', 'religion',
  'birth_reg_no', 'gender', 'emergency_contact', 'height', 'last_class',
  'last_version', 'last_institute', 'present_address', 'permanent_address',
  'co_curricular', 'student_photo',
  'father_name', 'father_profession', 'father_contact', 'father_nid',
  'mother_name', 'mother_profession', 'mother_contact', 'mother_nid',
  'guardian_name', 'guardian_contact', 'guardian_relation',
]);

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { action, payload = {} } = body;

  // ── Config: choices for the application form ────────────────────────────────
  if (action === 'config') {
    const rows = await sb(`admission_settings?key=eq.index_settings`);
    const idx = (rows && !rows.error && rows[0]) ? rows[0].value : {};
    const classes = Object.keys(idx.classCodes || {});
    const categories = Object.keys(idx.categoryCodes || {});
    const year = new Date().getFullYear();
    return NextResponse.json({
      classes, categories,
      sessions: [String(year), String(year + 1)],
    });
  }

  // ── Sign in (email). Google will replace this with a verified identity. ─────
  if (action === 'login') {
    const email = String(payload.email || '').trim().toLowerCase();
    const name = String(payload.name || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' });
    }
    const token = signSession({ email, name, exp: Date.now() + SESSION_TTL_MS });
    return NextResponse.json({ email, name }, { headers: { 'Set-Cookie': sessionCookie(token) } });
  }

  if (action === 'me') {
    const s = readSession(req);
    return NextResponse.json({ authed: !!s, email: s?.email || null, name: s?.name || null });
  }

  if (action === 'logout') {
    return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': 'applicant_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' } });
  }

  // ── Submit an application ───────────────────────────────────────────────────
  if (action === 'submit') {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });

    const form = payload.data || {};
    if (!form.name_english || !form.class || !form.session) {
      return NextResponse.json({ error: 'Name, class and session are required.' });
    }

    // Whitelist the fields the applicant may set.
    const data = {};
    for (const k of Object.keys(form)) if (ALLOWED_FIELDS.has(k)) data[k] = form[k];
    data.applicant_email = session.email;
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
      const row = { ...data, tracking_id: trackingId, index_id: buildIndexId(indexSettings, data.session, data.class, counter) };
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
    const rows = await sb(`admission_applications?applicant_email=eq.${encodeURIComponent(session.email)}&select=id,tracking_id,index_id,name_english,class,category,version,session,status,created_at&order=created_at.desc`);
    return NextResponse.json({ applications: (rows && !rows.error) ? rows : [] });
  }

  // ── Public status lookup by tracking number (no sign-in needed) ─────────────
  if (action === 'track') {
    const t = String(payload.tracking_id || '').trim().toUpperCase();
    if (!t) return NextResponse.json({ error: 'Enter a tracking number.' });
    const rows = await sb(`admission_applications?tracking_id=eq.${encodeURIComponent(t)}&select=tracking_id,index_id,name_english,class,session,status`);
    const app = (rows && !rows.error && rows[0]) ? rows[0] : null;
    if (!app) return NextResponse.json({ found: false });
    return NextResponse.json({ found: true, application: app });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
