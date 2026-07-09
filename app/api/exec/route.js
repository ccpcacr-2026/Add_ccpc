import { NextResponse } from 'next/server';
import crypto from 'crypto';

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'ccpc2026';

// ── Role-based admin sessions ─────────────────────────────────────────────────
// Besides the master ADMIN_PASSWORD, staff who hold the 'Admission Admin' role
// in the teachers portal (teacher.app_users, comma-separated role tokens) can
// sign in with their own user id + password. Their session is a signed HMAC
// token so requests after login don't re-hit the teacher schema.
const SESSION_SECRET = process.env.APPLICANT_SESSION_SECRET || SB_KEY || 'dev-secret';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signAdminSession(data) {
  const payload = b64url(JSON.stringify(data));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update('admadm.' + payload).digest('base64url');
  return 'aa1.' + payload + '.' + sig;
}
function verifyAdminSession(token) {
  if (typeof token !== 'string' || !token.startsWith('aa1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update('admadm.' + parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data; try { data = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
  if (!data || !data.exp || Date.now() > data.exp) return null;
  return data;
}

// Read-only lookup against the teachers portal's schema (login only)
async function sbTeacher(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': 'teacher',
    },
  });
  const text = await res.text();
  if (!res.ok) return { error: text };
  return text ? JSON.parse(text) : null;
}

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
  if (!res.ok) return { error: text };
  return text ? JSON.parse(text) : null;
}

async function sbRpc(fn, params = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'admission',
      'Content-Profile': 'admission',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) return null;
  return text ? JSON.parse(text) : null;
}

function circSymbolServer(entry, dims) {
  var parts = (dims || []).map(function(dim) {
    var sel = ((entry.selections || {})[dim.id]) || [];
    if (!sel.length) return null;
    var syms = [];
    (dim.options || []).forEach(function(opt) {
      if (sel.includes(opt.value) && opt.symbol && !syms.includes(opt.symbol)) syms.push(opt.symbol);
    });
    return syms.join('') || null;
  }).filter(Boolean);
  return parts.join('-');
}
function findCircularEntry(appData, circ) {
  var dims = circ.dimensions || [];
  var LABEL_FIELD = {'Class':'class','Version':'version','Category':'category','Group':'group','Section':'section'};
  return (circ.entries || []).find(function(entry) {
    if (!entry.active) return false;
    return dims.every(function(dim) {
      var field = LABEL_FIELD[dim.label];
      if (!field) return true;
      var sel = ((entry.selections || {})[dim.id]) || [];
      if (!sel.length) return true;
      return sel.includes(appData[field]);
    });
  });
}

function buildIndexId(settings, session, cls, counter) {
  const pattern     = settings.pattern || '{YY}{CLASS}{SEQ4}';
  const classCodes  = settings.classCodes  || {};
  const catCodes    = settings.categoryCodes || {};
  const yr          = String(session || new Date().getFullYear());
  const classCode   = classCodes[cls]  || '';
  const seq         = counter || 1;
  return pattern
    .replace('{YYYY}', yr)
    .replace('{YY}',   yr.slice(-2))
    .replace('{CLASS}',classCode)
    .replace('{CAT}',  catCodes[cls] || 'X')
    .replace('{SEQ5}', String(seq).padStart(5,'0'))
    .replace('{SEQ4}', String(seq).padStart(4,'0'))
    .replace('{SEQ3}', String(seq).padStart(3,'0'));
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { action, payload = {}, token } = body;

  // ── Login ────────────────────────────────────────────────────────────────
  // Two ways in: master password (full access, as before), or teachers-portal
  // credentials for a user holding the 'Admission Admin' role.
  if (action === 'login') {
    const userId = String(payload.userId || '').trim();
    if (!userId) {
      if (payload.password === ADMIN_PASS) return NextResponse.json({ token: ADMIN_PASS, who: 'Master Admin' });
      return NextResponse.json({ error: 'Invalid password' });
    }
    const clean = encodeURIComponent(userId);
    const rows = await sbTeacher(`app_users?or=(user_id.eq.${clean},email.eq.${clean})&select=user_id,email,password,role`);
    if (!Array.isArray(rows) || !rows.length) return NextResponse.json({ error: 'User not found' });
    const user = rows[0];
    if (String(user.password).trim() !== String(payload.password || '').trim()) {
      return NextResponse.json({ error: 'Invalid password' });
    }
    const roles = String(user.role || '').split(',').map(r => r.trim()).filter(Boolean);
    if (!roles.includes('Admission Admin')) {
      return NextResponse.json({ error: 'This account does not have the Admission Admin role' });
    }
    const sessionToken = signAdminSession({ uid: user.user_id, exp: Date.now() + ADMIN_SESSION_TTL_MS });
    return NextResponse.json({ token: sessionToken, who: user.user_id, role: 'Admission Admin' });
  }
  const isMaster = token === ADMIN_PASS;
  const roleSession = isMaster ? null : verifyAdminSession(token);
  if (!isMaster && !roleSession) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── List Applications ────────────────────────────────────────────────────
  if (action === 'listApplications') {
    let q = 'admission_applications?select=id,tracking_id,index_id,name_english,name_bangla,class,category,version,session,status,stage,payment_status,room_no,created_at&order=created_at.desc&limit=1000';
    if (payload.session) q += `&session=eq.${encodeURIComponent(payload.session)}`;
    if (payload.class)   q += `&class=eq.${encodeURIComponent(payload.class)}`;
    if (payload.status)  q += `&status=eq.${encodeURIComponent(payload.status)}`;
    const rows = await sb(q);
    if (rows?.error) return NextResponse.json({ error: rows.error });
    return NextResponse.json({ applications: rows || [] });
  }

  // ── Get Application ──────────────────────────────────────────────────────
  if (action === 'getApplication') {
    const rows = await sb(`admission_applications?id=eq.${payload.id}`);
    return NextResponse.json({ application: rows?.[0] || null });
  }

  // ── Save Application ─────────────────────────────────────────────────────
  if (action === 'saveApplication') {
    const { id, data } = payload;
    data.updated_at = new Date().toISOString();

    if (!id) {
      // Tracking ID from Supabase hex sequence
      const trackingId = await sbRpc('generate_tracking_id', {});
      data.tracking_id = trackingId || Math.random().toString(16).slice(2,8).toUpperCase();

      // Index ID from pattern + atomic counter (symbol-based if circular is configured)
      const settingsRows = await sb('admission_settings?key=in.(index_settings,circular_settings)');
      const indexSettings = settingsRows?.find(r=>r.key==='index_settings')?.value || {};
      const circSettings  = settingsRows?.find(r=>r.key==='circular_settings')?.value || {};
      let counterKey = data.class || '';
      if (circSettings.useSymbolCounter && circSettings.entries && circSettings.dimensions) {
        const matched = findCircularEntry(data, circSettings);
        if (matched) {
          const sym = matched.symbolOverride || circSymbolServer(matched, circSettings.dimensions);
          if (sym) counterKey = sym;
        }
      }
      const counter = await sbRpc('increment_index_counter', {
        p_year:  String(data.session || new Date().getFullYear()),
        p_class: counterKey,
      });
      data.index_id    = buildIndexId(indexSettings, data.session, data.class, counter);
      data.created_at  = new Date().toISOString();
      data.status      = data.status || 'Pending';

      const res = await sb('admission_applications', 'POST', data);
      if (res?.error) return NextResponse.json({ error: res.error });
      return NextResponse.json({
        id:          res?.[0]?.id,
        tracking_id: data.tracking_id,
        index_id:    data.index_id,
      });
    } else {
      const res = await sb(`admission_applications?id=eq.${id}`, 'PATCH', data);
      if (res?.error) return NextResponse.json({ error: res.error });
      return NextResponse.json({ id });
    }
  }

  // ── Delete Application ───────────────────────────────────────────────────
  if (action === 'deleteApplication') {
    await sb(`admission_applications?id=eq.${payload.id}`, 'DELETE');
    return NextResponse.json({ success: true });
  }

  // ── Update Status ────────────────────────────────────────────────────────
  if (action === 'updateStatus') {
    await sb(`admission_applications?id=eq.${payload.id}`, 'PATCH',
      { status: payload.status, updated_at: new Date().toISOString() });
    return NextResponse.json({ success: true });
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  if (action === 'getStats') {
    const q = payload.session
      ? `admission_applications?select=status&session=eq.${encodeURIComponent(payload.session)}`
      : 'admission_applications?select=status';
    const rows = await sb(q);
    if (!rows || rows.error) return NextResponse.json({ stats: {} });
    const stats = { total: rows.length, pending: 0, admitted: 0, rejected: 0, called: 0 };
    rows.forEach(r => {
      if (r.status === 'Pending')        stats.pending++;
      if (r.status === 'Admitted')       stats.admitted++;
      if (r.status === 'Rejected')       stats.rejected++;
      if (r.status === 'Called for Test') stats.called++;
    });
    return NextResponse.json({ stats });
  }

  // ── Get Settings ─────────────────────────────────────────────────────────
  if (action === 'getSettings') {
    const rows = await sb('admission_settings');
    if (!rows || rows.error) return NextResponse.json({ settings: {} });
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    return NextResponse.json({ settings });
  }

  // ── Save Settings ────────────────────────────────────────────────────────
  if (action === 'saveSettings') {
    const { key, value } = payload;
    const existing = await sb(`admission_settings?key=eq.${encodeURIComponent(key)}`);
    if (existing && !existing.error && existing.length > 0) {
      await sb(`admission_settings?key=eq.${encodeURIComponent(key)}`, 'PATCH',
        { value, updated_at: new Date().toISOString() });
    } else {
      await sb('admission_settings', 'POST', { key, value, updated_at: new Date().toISOString() });
    }
    return NextResponse.json({ success: true });
  }

  // ── Preview Index ID ─────────────────────────────────────────────────────
  if (action === 'previewIndexId') {
    const { settings, session, cls, counter = 1 } = payload;
    return NextResponse.json({ preview: buildIndexId(settings, session, cls, counter) });
  }

  // ── Reset Counter ────────────────────────────────────────────────────────
  if (action === 'resetCounter') {
    const { year, cls } = payload;
    await sb(`index_counters?year=eq.${encodeURIComponent(year)}&class=eq.${encodeURIComponent(cls)}`,
      'DELETE');
    return NextResponse.json({ success: true });
  }

  // ── List Counters ────────────────────────────────────────────────────────
  if (action === 'listCounters') {
    const rows = await sb('index_counters?order=year.desc,class.asc');
    return NextResponse.json({ counters: rows || [] });
  }

  // ── PAYMENTS ───────────────────────────────────────────────────────────────

  // Payment records (gateway + manual), newest first, joined with the
  // application's identifying info so the review list is self-explanatory.
  if (action === 'listPayments') {
    let q = 'admission_payments?select=*&order=created_at.desc&limit=500';
    if (payload.status) q += `&status=eq.${encodeURIComponent(payload.status)}`;
    const pays = await sb(q);
    if (!Array.isArray(pays)) return NextResponse.json({ payments: [] });
    const ids = [...new Set(pays.map(p => p.application_id).filter(Boolean))];
    let appsById = {};
    if (ids.length) {
      const apps = await sb(`admission_applications?id=in.(${ids.join(',')})&select=id,tracking_id,index_id,name_english,class,session,payment_status,stage`);
      if (Array.isArray(apps)) for (const a of apps) appsById[a.id] = a;
    }
    return NextResponse.json({ payments: pays.map(p => ({ ...p, application: appsById[p.application_id] || null })) });
  }

  // Verify or reject a manual (TrxID) payment.
  if (action === 'verifyPayment') {
    const pid = parseInt(payload.paymentId, 10);
    const approve = !!payload.approve;
    if (!pid) return NextResponse.json({ error: 'Missing payment id' });
    const rows = await sb(`admission_payments?id=eq.${pid}&select=*`);
    const p = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
    if (!p) return NextResponse.json({ error: 'Payment not found' });
    const pRes = await sb(`admission_payments?id=eq.${pid}`, 'PATCH', {
      status: approve ? 'verified' : 'rejected', updated_at: new Date().toISOString(),
    });
    if (pRes && pRes.error) return NextResponse.json({ error: 'Could not update payment' });
    if (p.application_id) {
      const aRes = await sb(`admission_applications?id=eq.${p.application_id}`, 'PATCH', approve ? {
        payment_status: 'verified', stage: 'paid', paid_at: new Date().toISOString(),
        payment_amount: p.amount, updated_at: new Date().toISOString(),
      } : {
        payment_status: 'rejected', updated_at: new Date().toISOString(),
      });
      if (aRes && aRes.error) return NextResponse.json({ error: 'Payment updated but the application row failed — retry.' });
    }
    return NextResponse.json({ success: true });
  }

  // Manual override: mark an application paid without a payment record
  // (e.g. fee collected at the college office).
  if (action === 'markPaid') {
    const appId = parseInt(payload.appId, 10);
    if (!appId) return NextResponse.json({ error: 'Missing application id' });
    const res = await sb(`admission_applications?id=eq.${appId}`, 'PATCH', {
      payment_status: 'verified', stage: 'paid', paid_at: new Date().toISOString(),
      payment_method: 'offline', updated_at: new Date().toISOString(),
    });
    if (res && res.error) return NextResponse.json({ error: 'Could not update' });
    return NextResponse.json({ success: true });
  }

  // ── ADMIT CARDS ────────────────────────────────────────────────────────────

  // Bulk-issue admit cards from an uploaded room list. Each row is
  // { key, room } where key matches either a tracking_id or an index_id.
  // Applications are grouped by room so the whole issue is a handful of
  // PATCHes rather than one per student.
  if (action === 'issueAdmits') {
    const list = Array.isArray(payload.rows) ? payload.rows : [];
    if (!list.length) return NextResponse.json({ error: 'No rows to issue' });
    const apps = await sb('admission_applications?select=id,tracking_id,index_id&limit=10000');
    if (!Array.isArray(apps)) return NextResponse.json({ error: 'Could not load applications' });
    const byKey = {};
    for (const a of apps) {
      if (a.tracking_id) byKey[String(a.tracking_id).trim().toUpperCase()] = a.id;
      if (a.index_id) byKey[String(a.index_id).trim().toUpperCase()] = a.id;
    }
    const unmatched = [];
    const roomByAppId = {};
    for (const r of list) {
      const key = String(r.key || '').trim().toUpperCase();
      const room = String(r.room || '').trim();
      if (!key || !room) continue;
      const appId = byKey[key];
      if (appId) roomByAppId[appId] = room; else unmatched.push(key);
    }
    // group ids per room → one PATCH per distinct room
    const idsByRoom = {};
    for (const [appId, room] of Object.entries(roomByAppId)) (idsByRoom[room] = idsByRoom[room] || []).push(appId);
    const now = new Date().toISOString();
    let updated = 0;
    for (const [room, ids] of Object.entries(idsByRoom)) {
      const res = await sb(`admission_applications?id=in.(${ids.join(',')})`, 'PATCH', {
        room_no: room, admit_issued_at: now, updated_at: now,
      });
      if (!(res && res.error)) updated += ids.length;
    }
    return NextResponse.json({ success: true, updated, matched: Object.keys(roomByAppId).length, unmatched });
  }

  return NextResponse.json({ error: 'Unknown action' });
}
