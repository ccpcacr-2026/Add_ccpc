import { NextResponse } from 'next/server';

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'ccpc2026';

async function sb(path, method = 'GET', body = null) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
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
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) return null;
  return text ? JSON.parse(text) : null;
}

function buildIndexId(settings, session, cls, counter) {
  const pattern     = settings.pattern || '{YY}{CLASS}{SEQ4}';
  const classCodes  = settings.classCodes  || {};
  const catCodes    = settings.categoryCodes || {};
  const yr          = String(session || new Date().getFullYear());
  const classCode   = classCodes[cls]  || (cls  || 'XX').replace(/\s/g,'').slice(0,2).toUpperCase();
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
  if (action === 'login') {
    if (payload.password === ADMIN_PASS) return NextResponse.json({ token: ADMIN_PASS });
    return NextResponse.json({ error: 'Invalid password' });
  }
  if (token !== ADMIN_PASS) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── List Applications ────────────────────────────────────────────────────
  if (action === 'listApplications') {
    let q = 'admission_applications?select=id,tracking_id,index_id,name_english,name_bangla,class,category,version,session,status,created_at&order=created_at.desc&limit=1000';
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

      // Index ID from pattern + atomic counter
      const settingsRows = await sb('admission_settings?key=eq.index_settings');
      const indexSettings = settingsRows?.[0]?.value || {};
      const counter = await sbRpc('increment_index_counter', {
        p_year:  String(data.session || new Date().getFullYear()),
        p_class: data.class || '',
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

  return NextResponse.json({ error: 'Unknown action' });
}
