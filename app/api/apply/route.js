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
  'father_name', 'father_profession', 'father_designation', 'father_education',
  'father_contact', 'father_nid', 'father_office_address', 'father_yearly_income', 'father_photo',
  'mother_name', 'mother_profession', 'mother_designation', 'mother_education',
  'mother_contact', 'mother_nid', 'mother_office_address', 'mother_yearly_income', 'mother_photo',
  'guardian_name', 'guardian_profession', 'guardian_designation', 'guardian_education',
  'guardian_contact', 'guardian_nid', 'guardian_relation', 'guardian_office_address', 'guardian_photo',
]);

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
    const rows = await sb(`admission_settings?key=in.(index_settings,circular_settings)`);
    const arr = (rows && !rows.error && Array.isArray(rows)) ? rows : [];
    const idx  = (arr.find(r => r.key === 'index_settings')    || {}).value || {};
    const circ = (arr.find(r => r.key === 'circular_settings') || {}).value || {};
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
    const year = new Date().getFullYear();
    return NextResponse.json({
      classes, byClass,
      categories: allCategories,
      sessions: [String(year), String(year + 1)],
      open: openClasses.length > 0,
      circularTitle: circ.title || '',
      circularSession: circ.session || '',
      startDate: circ.startDate || '', endDate: circ.endDate || '',
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
    const token = signSession({ email: info.email, name: info.name, exp: Date.now() + SESSION_TTL_MS });
    return NextResponse.json({ email: info.email, name: info.name }, { headers: { 'Set-Cookie': sessionCookie(token) } });
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
    const safe = String(session.email).replace(/[^a-z0-9]/gi, '_').slice(0, 40);
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
    const dupQ = `admission_applications?applicant_email=eq.${encodeURIComponent(session.email)}` +
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
        applicant_email: session.email,
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
    const data = {};
    for (const k of Object.keys(form)) if (ALLOWED_FIELDS.has(k) && !LOCKED.has(k)) data[k] = form[k];
    data.updated_at = new Date().toISOString();
    const q = `admission_applications?id=eq.${id}&applicant_email=eq.${encodeURIComponent(session.email)}&stage=eq.initiated`;
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
    const rows = await sb(`admission_applications?id=eq.${id}&applicant_email=eq.${encodeURIComponent(session.email)}&select=id,stage,name_english,student_photo`);
    const app = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
    if (!app) return NextResponse.json({ error: 'Application not found.' });
    if (app.stage !== 'initiated') return NextResponse.json({ error: 'This application is already submitted.' });
    const missing = [];
    if (!app.name_english) missing.push("applicant's name (English)");
    if (!app.student_photo) missing.push("student photo");
    if (missing.length) return NextResponse.json({ error: 'Please complete before submitting: ' + missing.join(', ') + '. (Use Save progress first.)' });
    const upd = await fetch(`${SB_URL}/rest/v1/admission_applications?id=eq.${id}&applicant_email=eq.${encodeURIComponent(session.email)}&stage=eq.initiated`, {
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
    const rows = await sb(`admission_applications?id=eq.${id}&applicant_email=eq.${encodeURIComponent(session.email)}&select=id,class,stage,payment_status,payment_amount,paid_at,tracking_id`);
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
    const rows = await sb(`admission_applications?id=eq.${id}&applicant_email=eq.${encodeURIComponent(session.email)}&select=*`);
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
    const rows = await sb(`admission_applications?applicant_email=eq.${encodeURIComponent(session.email)}&select=*&order=created_at.desc`);
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
