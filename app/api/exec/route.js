import { NextResponse } from 'next/server';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'ccpc2026';

async function sb(path, method = 'GET', body = null) {
  const url = `${SB_URL}/rest/v1/${path}`;
  const opts = {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal'
    }
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) return { error: text };
  return text ? JSON.parse(text) : null;
}

function genTrackingId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function genIndexId(session, cls) {
  const yr = String(session || new Date().getFullYear()).slice(-2);
  const cl = String(cls || '').replace(/\s/g, '').slice(0, 2).toUpperCase();
  const rnd = Math.floor(100000 + Math.random() * 900000);
  return `${yr}${cl}${rnd}`;
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const { action, payload = {}, token } = body;

  // ── Login ──────────────────────────────────────────────────────────────
  if (action === 'login') {
    if (payload.password === ADMIN_PASS) return NextResponse.json({ token: ADMIN_PASS });
    return NextResponse.json({ error: 'Invalid password' });
  }

  if (token !== ADMIN_PASS) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── List Applications ──────────────────────────────────────────────────
  if (action === 'listApplications') {
    let q = 'admission_applications?select=id,tracking_id,index_id,name_english,name_bangla,class,category,version,session,status,created_at&order=created_at.desc&limit=500';
    if (payload.session) q += `&session=eq.${encodeURIComponent(payload.session)}`;
    if (payload.class)   q += `&class=eq.${encodeURIComponent(payload.class)}`;
    if (payload.status)  q += `&status=eq.${encodeURIComponent(payload.status)}`;
    const rows = await sb(q);
    if (rows && rows.error) return NextResponse.json({ error: rows.error });
    return NextResponse.json({ applications: rows || [] });
  }

  // ── Get Single ────────────────────────────────────────────────────────
  if (action === 'getApplication') {
    const rows = await sb(`admission_applications?id=eq.${payload.id}`);
    return NextResponse.json({ application: rows && rows[0] || null });
  }

  // ── Save (create or update) ───────────────────────────────────────────
  if (action === 'saveApplication') {
    const { id, data } = payload;
    data.updated_at = new Date().toISOString();
    if (!id) {
      if (!data.tracking_id) data.tracking_id = genTrackingId();
      if (!data.index_id)    data.index_id    = genIndexId(data.session, data.class);
      data.created_at = new Date().toISOString();
      data.status = data.status || 'Pending';
      const res = await sb('admission_applications', 'POST', data);
      if (res && res.error) return NextResponse.json({ error: res.error });
      return NextResponse.json({ id: res && res[0] && res[0].id });
    } else {
      const res = await sb(`admission_applications?id=eq.${id}`, 'PATCH', data);
      if (res && res.error) return NextResponse.json({ error: res.error });
      return NextResponse.json({ id });
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────
  if (action === 'deleteApplication') {
    await sb(`admission_applications?id=eq.${payload.id}`, 'DELETE');
    return NextResponse.json({ success: true });
  }

  // ── Update Status ─────────────────────────────────────────────────────
  if (action === 'updateStatus') {
    await sb(`admission_applications?id=eq.${payload.id}`, 'PATCH', { status: payload.status, updated_at: new Date().toISOString() });
    return NextResponse.json({ success: true });
  }

  // ── Stats ──────────────────────────────────────────────────────────────
  if (action === 'getStats') {
    const q = payload.session
      ? `admission_applications?select=status&session=eq.${encodeURIComponent(payload.session)}`
      : 'admission_applications?select=status';
    const rows = await sb(q);
    if (!rows || rows.error) return NextResponse.json({ stats: {} });
    const stats = { total: rows.length, pending: 0, admitted: 0, rejected: 0, called: 0 };
    rows.forEach(r => {
      if (r.status === 'Pending')  stats.pending++;
      if (r.status === 'Admitted') stats.admitted++;
      if (r.status === 'Rejected') stats.rejected++;
      if (r.status === 'Called for Test') stats.called++;
    });
    return NextResponse.json({ stats });
  }

  return NextResponse.json({ error: 'Unknown action' });
}
