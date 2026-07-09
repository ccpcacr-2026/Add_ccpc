import { NextResponse } from 'next/server';
import crypto from 'crypto';

// ── Application fee payments ──────────────────────────────────────────────────
// Gateway: SSLCommerz hosted checkout (v4). Credentials are entered by the
// admin in the admission admin panel (Payments settings) and stored in
// admission_settings.payment_settings — server-side only, never sent to
// applicants. While no credentials are saved, the manual fallback (send
// bKash/Nagad, enter TrxID, admin verifies) keeps payments usable.
//
// JSON actions (applicant session cookie):   init, manualSubmit
// Gateway callbacks (form-encoded, no session; trusted only after the
// server-to-server validator API confirms):  ?cb=success|fail|cancel|ipn

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_SECRET = process.env.APPLICANT_SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev-secret';

async function sb(path, method = 'GET', body = null, prefer = null) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || (method === 'GET' ? 'return=minimal' : 'return=representation'),
      'Accept-Profile': 'admission',
      'Content-Profile': 'admission',
    },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) return { error: text, status: res.status };
  return text ? JSON.parse(text) : null;
}

// Same applicant session cookie as /api/apply (keep the two in sync).
function readSession(req) {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)applicant_session=([^;]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; } catch { return null; }
  let data;
  try { data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
  if (!data.email || !data.exp || Date.now() > data.exp) return null;
  return data;
}

async function loadPaySettings() {
  const rows = await sb(`admission_settings?key=in.(payment_settings,circular_settings)`);
  const arr = (rows && !rows.error && Array.isArray(rows)) ? rows : [];
  return {
    pay: (arr.find(r => r.key === 'payment_settings') || {}).value || {},
    circ: (arr.find(r => r.key === 'circular_settings') || {}).value || {},
  };
}
function resolveFee(pay, circ, cls) {
  const circCls = (Array.isArray(circ.classes) ? circ.classes : []).find(c => c && c.class === cls);
  return Number(circCls && circCls.fee) || Number(pay.defaultFee) || 0;
}
function sslBase(pay) {
  return pay.sslSandbox !== false ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';
}
function siteBase(req) {
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'ccpc-admission.vercel.app';
  return `${proto}://${host}`;
}

async function markPaid(app_id, { method, ref, amount }) {
  return sb(`admission_applications?id=eq.${app_id}`, 'PATCH', {
    payment_status: 'verified', stage: 'paid', paid_at: new Date().toISOString(),
    payment_method: method, payment_ref: ref || null,
    ...(amount != null ? { payment_amount: amount } : {}),
    updated_at: new Date().toISOString(),
  });
}

// ── Gateway callbacks ─────────────────────────────────────────────────────────
async function handleCallback(req, cb) {
  let form = {};
  try {
    const fd = await req.formData();
    for (const [k, v] of fd.entries()) form[k] = String(v);
  } catch { /* GET redirects carry no body */ }
  const tranId = form.tran_id || new URL(req.url).searchParams.get('t') || '';
  const home = `${siteBase(req)}/apply.html`;

  const payRows = tranId ? await sb(`admission_payments?tran_id=eq.${encodeURIComponent(tranId)}&select=*`) : null;
  const payment = (Array.isArray(payRows) && payRows[0]) ? payRows[0] : null;
  if (!payment) return NextResponse.redirect(`${home}?pay=error`, 303);

  if (cb === 'fail' || cb === 'cancel') {
    if (payment.status === 'initiated') {
      await sb(`admission_payments?id=eq.${payment.id}`, 'PATCH', { status: cb === 'fail' ? 'failed' : 'cancelled', raw: form, updated_at: new Date().toISOString() });
    }
    return NextResponse.redirect(`${home}?pay=${cb === 'fail' ? 'failed' : 'cancelled'}`, 303);
  }

  // success / ipn — never trust the redirect alone; confirm with the validator API.
  const { pay } = await loadPaySettings();
  const valId = form.val_id || '';
  if (!valId || !pay.sslStoreId || !pay.sslStorePass) {
    return NextResponse.redirect(`${home}?pay=error`, 303);
  }
  const vUrl = `${sslBase(pay)}/validator/api/validationserverAPI.php?val_id=${encodeURIComponent(valId)}` +
    `&store_id=${encodeURIComponent(pay.sslStoreId)}&store_passwd=${encodeURIComponent(pay.sslStorePass)}&format=json`;
  let v = null;
  try { v = await (await fetch(vUrl, { signal: AbortSignal.timeout(15000) })).json(); } catch { v = null; }
  const valid = v && (v.status === 'VALID' || v.status === 'VALIDATED') && String(v.tran_id) === String(tranId) &&
    Math.abs(Number(v.amount) - Number(payment.amount)) < 0.01;

  if (!valid) {
    await sb(`admission_payments?id=eq.${payment.id}`, 'PATCH', { status: 'failed', val_id: valId, raw: { form, validator: v }, updated_at: new Date().toISOString() });
    return NextResponse.redirect(`${home}?pay=failed`, 303);
  }
  await sb(`admission_payments?id=eq.${payment.id}`, 'PATCH', { status: 'valid', val_id: valId, raw: { form, validator: v }, updated_at: new Date().toISOString() });
  await markPaid(payment.application_id, { method: 'sslcommerz', ref: v.bank_tran_id || valId, amount: Number(v.amount) });
  if (cb === 'ipn') return NextResponse.json({ ok: true });
  return NextResponse.redirect(`${home}?pay=success`, 303);
}

export async function GET(req) {
  const cb = new URL(req.url).searchParams.get('cb');
  if (cb) return handleCallback(req, cb);
  return NextResponse.json({ error: 'Bad request' }, { status: 400 });
}

export async function POST(req) {
  const cb = new URL(req.url).searchParams.get('cb');
  if (cb) return handleCallback(req, cb);

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { action, payload = {} } = body;
  const session = readSession(req);
  if (!session) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 });

  const id = parseInt(payload.id, 10);
  if (!id) return NextResponse.json({ error: 'Missing application id.' });
  const rows = await sb(`admission_applications?id=eq.${id}&applicant_email=eq.${encodeURIComponent(session.email)}&select=id,class,session,stage,payment_status,tracking_id,name_english,applicant_email,emergency_contact,present_address`);
  const app = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
  if (!app) return NextResponse.json({ error: 'Application not found.' });
  if (app.stage === 'initiated') return NextResponse.json({ error: 'Submit the application before paying.' });
  if (app.payment_status === 'verified') return NextResponse.json({ error: 'This application is already paid.' });

  const { pay, circ } = await loadPaySettings();
  const fee = resolveFee(pay, circ, app.class);
  if (!(fee > 0)) return NextResponse.json({ error: 'The application fee has not been configured yet. Please try again later.' });

  // ── Start a hosted-checkout session ────────────────────────────────────────
  if (action === 'init') {
    if (!(pay.sslStoreId && pay.sslStorePass && pay.gatewayEnabled !== false)) {
      return NextResponse.json({ error: 'Online payment is not available right now. Use the manual option.' });
    }
    const tranId = `ADM${id}T${Date.now().toString(36).toUpperCase()}`;
    const ins = await sb('admission_payments', 'POST', {
      application_id: id, tran_id: tranId, gateway: 'sslcommerz', amount: fee,
      currency: pay.currency || 'BDT', status: 'initiated',
    });
    if (ins && ins.error) return NextResponse.json({ error: 'Could not start payment. Try again.' });

    const base = siteBase(req);
    const params = new URLSearchParams({
      store_id: pay.sslStoreId, store_passwd: pay.sslStorePass,
      total_amount: String(fee), currency: pay.currency || 'BDT', tran_id: tranId,
      success_url: `${base}/api/pay?cb=success&t=${tranId}`,
      fail_url: `${base}/api/pay?cb=fail&t=${tranId}`,
      cancel_url: `${base}/api/pay?cb=cancel&t=${tranId}`,
      ipn_url: `${base}/api/pay?cb=ipn&t=${tranId}`,
      shipping_method: 'NO', product_name: `Admission fee — ${app.class} (${app.tracking_id})`,
      product_category: 'Admission', product_profile: 'non-physical-goods',
      cus_name: app.name_english || 'Applicant', cus_email: app.applicant_email || session.email,
      cus_add1: app.present_address || 'Chattogram', cus_city: 'Chattogram', cus_country: 'Bangladesh',
      cus_phone: app.emergency_contact || '01000000000',
    });
    let g = null;
    try {
      const res = await fetch(`${sslBase(pay)}/gwprocess/v4/api.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(20000),
      });
      g = await res.json();
    } catch { g = null; }
    if (!g || g.status !== 'SUCCESS' || !g.GatewayPageURL) {
      await sb(`admission_payments?tran_id=eq.${encodeURIComponent(tranId)}`, 'PATCH', { status: 'failed', raw: g, updated_at: new Date().toISOString() });
      return NextResponse.json({ error: 'The payment gateway rejected the request. ' + String((g && (g.failedreason || g.status)) || 'Check the gateway settings.') });
    }
    return NextResponse.json({ url: g.GatewayPageURL, tran_id: tranId, amount: fee });
  }

  // ── Manual fallback: applicant reports a bKash/Nagad TrxID, admin verifies ──
  if (action === 'manualSubmit') {
    if (pay.manualEnabled === false) return NextResponse.json({ error: 'Manual payment is not enabled.' });
    const method = String(payload.method || '').trim().slice(0, 30);
    const trxId = String(payload.trxId || '').trim().slice(0, 60);
    const payer = String(payload.payerNumber || '').trim().slice(0, 30);
    if (!method || !trxId) return NextResponse.json({ error: 'Enter the payment method and Transaction ID.' });
    const ins = await sb('admission_payments', 'POST', {
      application_id: id, tran_id: `MAN${id}T${Date.now().toString(36).toUpperCase()}`,
      gateway: 'manual', amount: fee, currency: pay.currency || 'BDT',
      status: 'review', payer_ref: payer, raw: { method, trxId },
    });
    if (ins && ins.error) return NextResponse.json({ error: 'Could not record your payment. Try again.' });
    await sb(`admission_applications?id=eq.${id}`, 'PATCH', {
      payment_status: 'review', payment_method: method, payment_ref: trxId, payment_amount: fee,
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json({ success: true, status: 'review' });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
