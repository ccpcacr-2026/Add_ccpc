/* ═══════════════════════════════════════════════════════
   CCPC Admission — Frontend Logic
   ═══════════════════════════════════════════════════════ */

let AUTH_TOKEN = null;
let allApplications = [];
let currentId = null; // editing record ID (null = new)

/* ─── Utility ─────────────────────────────────────────── */
function show(el) { if (el) { el.classList.remove('hidden'); el.classList.add('flex'); } }
function hide(el) { if (el) { el.classList.add('hidden'); el.classList.remove('flex'); } }
function showEl(id) { show(document.getElementById(id)); }
function hideEl(id) { hide(document.getElementById(id)); }
function setLoading(on) { const el = document.getElementById('loading'); on ? show(el) : hide(el); }
function v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function setV(id, val) { const e = document.getElementById(id); if (e) e.value = val || ''; }

function toast(msg, type = 'info') {
  const colors = { success: 'bg-emerald-500', error: 'bg-red-500', info: 'bg-blue-600', warn: 'bg-amber-500' };
  const icons  = { success: 'check-circle', error: 'x-circle', info: 'info', warn: 'alert-triangle' };
  const t = document.createElement('div');
  t.className = `flex items-center gap-3 px-4 py-3 rounded-2xl text-white text-xs font-bold shadow-xl max-w-xs ${colors[type]} animate-toast`;
  t.innerHTML = `<i data-lucide="${icons[type]}" class="h-4 w-4 shrink-0"></i><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(t);
  if (typeof lucide !== 'undefined') lucide.createIcons({ el: t });
  setTimeout(() => t.remove(), 3500);
}

/* ─── Confirm dialog ─────────────────────────────────── */
let _confirmResolve = null;
function openConfirm(msg, okLabel = 'Delete') {
  document.getElementById('confirmMsg').textContent = msg;
  document.getElementById('confirmOkBtn').textContent = okLabel;
  const m = document.getElementById('confirmModal');
  m.classList.remove('hidden'); m.classList.add('flex');
  return new Promise(res => { _confirmResolve = res; });
}
function closeConfirm(val = false) {
  const m = document.getElementById('confirmModal');
  m.classList.add('hidden'); m.classList.remove('flex');
  if (_confirmResolve) { _confirmResolve(val); _confirmResolve = null; }
}
document.getElementById('confirmOkBtn').onclick = () => closeConfirm(true);

/* ─── API ────────────────────────────────────────────── */
async function api(action, payload = {}) {
  const res = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, token: AUTH_TOKEN })
  });
  return res.json();
}

/* ─── Auth ───────────────────────────────────────────── */
document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  setLoading(true);
  const pass = document.getElementById('loginPass').value;
  const res = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', payload: { password: pass } })
  });
  const data = await res.json();
  setLoading(false);
  if (data.token) {
    AUTH_TOKEN = data.token;
    sessionStorage.setItem('admission_token', AUTH_TOKEN);
    document.getElementById('loginError').classList.add('hidden');
    enterApp();
  } else {
    document.getElementById('loginError').classList.remove('hidden');
  }
});

function logout() {
  AUTH_TOKEN = null;
  sessionStorage.removeItem('admission_token');
  hideEl('app-screen');
  showEl('login-screen');
  document.getElementById('loginPass').value = '';
}

function enterApp() {
  hideEl('login-screen');
  const as = document.getElementById('app-screen');
  as.classList.remove('hidden');
  as.classList.add('flex');
  loadDashboard();
}

/* ─── Init ───────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  if (typeof lucide !== 'undefined') lucide.createIcons();
  const saved = sessionStorage.getItem('admission_token');
  if (saved) {
    AUTH_TOKEN = saved;
    enterApp();
  }
});

/* ─── Dashboard ──────────────────────────────────────── */
async function loadDashboard() {
  showView('view-dashboard');
  document.getElementById('btn-dashboard').classList.add('hidden');
  document.getElementById('btn-new').classList.remove('hidden');
  document.getElementById('btn-new').classList.add('flex');
  setLoading(true);
  const res = await api('listApplications', {});
  setLoading(false);
  if (res.error) { toast(res.error, 'error'); return; }
  allApplications = res.applications || [];
  renderTable(allApplications);
  loadStats();
}

async function loadStats() {
  const res = await api('getStats', {});
  if (!res.stats) return;
  const s = res.stats;
  const cont = document.getElementById('topbar-stats');
  cont.innerHTML = `
    <span class="stat-chip">Total: <b>${s.total}</b></span>
    <span class="stat-chip text-amber-600">Pending: <b>${s.pending}</b></span>
    <span class="stat-chip text-emerald-600">Admitted: <b>${s.admitted}</b></span>
    <span class="stat-chip text-red-500">Rejected: <b>${s.rejected}</b></span>`;
}

const STATUS_COLORS = {
  'Pending':        'bg-amber-100 text-amber-700',
  'Called for Test':'bg-blue-100 text-blue-700',
  'Admitted':       'bg-emerald-100 text-emerald-700',
  'Rejected':       'bg-red-100 text-red-700'
};

function renderTable(apps) {
  const tbody = document.getElementById('app-table-body');
  if (!apps.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-10 text-center text-slate-400 text-sm">No applications found.</td></tr>';
    document.getElementById('app-count').textContent = '';
    return;
  }
  document.getElementById('app-count').textContent = `${apps.length} record${apps.length > 1 ? 's' : ''}`;
  tbody.innerHTML = apps.map(a => `
    <tr class="border-t border-slate-50 hover:bg-slate-50 transition-all cursor-pointer" onclick="loadForm(${a.id})">
      <td class="px-4 py-3">
        <span class="font-black text-blue-600 text-xs">#${a.tracking_id || '—'}</span>
        <br><span class="text-[9px] text-slate-400 font-bold">${a.index_id || ''}</span>
      </td>
      <td class="px-4 py-3">
        <p class="font-bold text-sm text-slate-800">${a.name_english || '—'}</p>
        <p class="text-[10px] text-slate-400">${a.name_bangla || ''}</p>
      </td>
      <td class="px-4 py-3 hidden md:table-cell text-sm font-bold text-slate-600">${a.class || '—'}</td>
      <td class="px-4 py-3 hidden md:table-cell text-sm text-slate-600">${a.category || '—'}</td>
      <td class="px-4 py-3 hidden lg:table-cell text-sm text-slate-500">${a.session || '—'}</td>
      <td class="px-4 py-3">
        <select class="status-pill ${STATUS_COLORS[a.status] || ''}" onchange="changeStatus(event,${a.id})" onclick="event.stopPropagation()">
          ${['Pending','Called for Test','Admitted','Rejected'].map(s => `<option${s===a.status?' selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="px-4 py-3 text-right whitespace-nowrap">
        <button onclick="event.stopPropagation();loadForm(${a.id})" class="action-btn"><i data-lucide="edit-2" class="h-3.5 w-3.5"></i></button>
        <button onclick="event.stopPropagation();printFromList(${a.id})" class="action-btn text-emerald-600 hover:bg-emerald-50"><i data-lucide="printer" class="h-3.5 w-3.5"></i></button>
        <button onclick="event.stopPropagation();deleteApp(${a.id})" class="action-btn text-red-400 hover:bg-red-50"><i data-lucide="trash-2" class="h-3.5 w-3.5"></i></button>
      </td>
    </tr>`).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function filterApps() {
  const q = (document.getElementById('searchInput').value || '').toLowerCase();
  const sess = document.getElementById('filterSession').value;
  const cls  = document.getElementById('filterClass').value;
  const stat = document.getElementById('filterStatus').value;
  const filtered = allApplications.filter(a => {
    if (q && !`${a.name_english||''} ${a.tracking_id||''} ${a.index_id||''}`.toLowerCase().includes(q)) return false;
    if (sess && a.session !== sess) return false;
    if (cls  && a.class  !== cls)   return false;
    if (stat && a.status !== stat)  return false;
    return true;
  });
  renderTable(filtered);
}

async function changeStatus(e, id) {
  e.stopPropagation();
  const status = e.target.value;
  const res = await api('updateStatus', { id, status });
  if (res.error) { toast(res.error, 'error'); return; }
  const app = allApplications.find(a => a.id === id);
  if (app) app.status = status;
  const sel = e.target;
  sel.className = `status-pill ${STATUS_COLORS[status] || ''}`;
  toast('Status updated', 'success');
  loadStats();
}

async function deleteApp(id) {
  const ok = await openConfirm('Delete this application permanently?');
  if (!ok) return;
  setLoading(true);
  const res = await api('deleteApplication', { id });
  setLoading(false);
  if (res.error) { toast(res.error, 'error'); return; }
  toast('Application deleted', 'success');
  allApplications = allApplications.filter(a => a.id !== id);
  filterApps();
  loadStats();
}

/* ─── Form ───────────────────────────────────────────── */
function showView(id) {
  ['view-dashboard','view-form'].forEach(v => {
    const el = document.getElementById(v);
    if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
  });
  const target = document.getElementById(id);
  if (target) target.classList.remove('hidden');
}

function showSection(id, btn) {
  document.querySelectorAll('.fsec').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.ftab').forEach(el => el.classList.remove('active'));
  document.getElementById(id).classList.remove('hidden');
  btn.classList.add('active');
}

function clearForm() {
  const ids = ['f-session','f-class','f-category','f-version','f-quota','f-status','f-tracking-id','f-index-id',
    'f-name-en','f-name-bn','f-dob','f-blood','f-gender','f-religion','f-birth-reg','f-nationality','f-emergency',
    'f-height','f-last-class','f-last-version','f-last-institute','f-present-address','f-permanent-address','f-co-curricular',
    'f-father-name','f-father-profession','f-father-designation','f-father-education','f-father-contact','f-father-nid','f-father-office','f-father-income',
    'f-mother-name','f-mother-profession','f-mother-designation','f-mother-education','f-mother-contact','f-mother-nid','f-mother-office','f-mother-income',
    'f-guardian-name','f-guardian-profession','f-guardian-designation','f-guardian-education','f-guardian-contact','f-guardian-relation','f-guardian-office'];
  ids.forEach(id => setV(id, ''));
  ['f-student-photo','f-father-photo','f-mother-photo','f-guardian-photo'].forEach(id => setV(id, ''));
  ['student-photo-preview','father-photo-preview','mother-photo-preview','guardian-photo-preview'].forEach(pid => {
    const el = document.getElementById(pid);
    if (el) el.innerHTML = `<i data-lucide="camera" class="h-6 w-6 text-slate-300"></i><span class="text-[9px] text-slate-400 mt-1">Click to upload</span>`;
  });
  setV('f-session', '2026');
  setV('f-class', 'Nursery');
  setV('f-category', 'Army');
  setV('f-version', 'Bangla');
  setV('f-quota', 'No');
  setV('f-status', 'Pending');
  setV('f-nationality', 'Bangladeshi');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function loadNewApplication() {
  currentId = null;
  clearForm();
  showView('view-form');
  document.getElementById('form-title').textContent = 'New Application';
  document.getElementById('btn-dashboard').classList.remove('hidden');
  document.getElementById('btn-dashboard').classList.add('flex');
  document.getElementById('btn-new').classList.add('hidden');
  // show first section
  const firstTab = document.querySelector('.ftab');
  if (firstTab) showSection('s-appinfo', firstTab);
}

async function loadForm(id) {
  currentId = id;
  showView('view-form');
  document.getElementById('form-title').textContent = 'Edit Application';
  document.getElementById('btn-dashboard').classList.remove('hidden');
  document.getElementById('btn-dashboard').classList.add('flex');
  document.getElementById('btn-new').classList.add('hidden');
  clearForm();
  setLoading(true);
  const res = await api('getApplication', { id });
  setLoading(false);
  const a = res.application;
  if (!a) { toast('Not found', 'error'); return; }
  setV('f-session', a.session);
  setV('f-class', a.class);
  setV('f-category', a.category);
  setV('f-version', a.version);
  setV('f-quota', a.quota || 'No');
  setV('f-status', a.status);
  setV('f-tracking-id', a.tracking_id);
  setV('f-index-id', a.index_id);
  setV('f-name-en', a.name_english); setV('f-name-bn', a.name_bangla);
  setV('f-dob', a.date_of_birth ? a.date_of_birth.split('T')[0] : '');
  setV('f-blood', a.blood_group); setV('f-gender', a.gender); setV('f-religion', a.religion);
  setV('f-birth-reg', a.birth_reg_no); setV('f-nationality', a.nationality || 'Bangladeshi');
  setV('f-emergency', a.emergency_contact); setV('f-height', a.height);
  setV('f-last-class', a.last_class); setV('f-last-version', a.last_version);
  setV('f-last-institute', a.last_institute);
  setV('f-present-address', a.present_address); setV('f-permanent-address', a.permanent_address);
  setV('f-co-curricular', a.co_curricular);
  setV('f-father-name', a.father_name); setV('f-father-profession', a.father_profession);
  setV('f-father-designation', a.father_designation); setV('f-father-education', a.father_education);
  setV('f-father-contact', a.father_contact); setV('f-father-nid', a.father_nid);
  setV('f-father-office', a.father_office_address); setV('f-father-income', a.father_yearly_income);
  setV('f-mother-name', a.mother_name); setV('f-mother-profession', a.mother_profession);
  setV('f-mother-designation', a.mother_designation); setV('f-mother-education', a.mother_education);
  setV('f-mother-contact', a.mother_contact); setV('f-mother-nid', a.mother_nid);
  setV('f-mother-office', a.mother_office_address); setV('f-mother-income', a.mother_yearly_income);
  setV('f-guardian-name', a.guardian_name); setV('f-guardian-profession', a.guardian_profession);
  setV('f-guardian-designation', a.guardian_designation); setV('f-guardian-education', a.guardian_education);
  setV('f-guardian-contact', a.guardian_contact); setV('f-guardian-relation', a.guardian_relation);
  setV('f-guardian-office', a.guardian_office_address);
  // Photos
  ['student','father','mother','guardian'].forEach(role => {
    const photo = a[`${role}_photo`];
    if (photo) {
      setV(`f-${role}-photo`, photo);
      const prev = document.getElementById(`${role}-photo-preview`);
      if (prev) prev.innerHTML = `<img src="${photo}" class="w-full h-full object-cover">`;
    }
  });
  const firstTab = document.querySelector('.ftab');
  if (firstTab) showSection('s-appinfo', firstTab);
}

function collectForm() {
  return {
    session: v('f-session'), class: v('f-class'), category: v('f-category'),
    version: v('f-version'), quota: v('f-quota'), status: v('f-status'),
    tracking_id: v('f-tracking-id') || null, index_id: v('f-index-id') || null,
    name_english: v('f-name-en') || null, name_bangla: v('f-name-bn') || null,
    date_of_birth: v('f-dob') || null, blood_group: v('f-blood') || null,
    gender: v('f-gender') || null, religion: v('f-religion') || null,
    birth_reg_no: v('f-birth-reg') || null, nationality: v('f-nationality') || 'Bangladeshi',
    emergency_contact: v('f-emergency') || null, height: v('f-height') || null,
    last_class: v('f-last-class') || null, last_version: v('f-last-version') || null,
    last_institute: v('f-last-institute') || null,
    present_address: v('f-present-address') || null, permanent_address: v('f-permanent-address') || null,
    co_curricular: v('f-co-curricular') || null,
    student_photo: document.getElementById('f-student-photo')?.value || null,
    father_name: v('f-father-name') || null, father_profession: v('f-father-profession') || null,
    father_designation: v('f-father-designation') || null, father_education: v('f-father-education') || null,
    father_contact: v('f-father-contact') || null, father_nid: v('f-father-nid') || null,
    father_office_address: v('f-father-office') || null, father_yearly_income: v('f-father-income') || null,
    father_photo: document.getElementById('f-father-photo')?.value || null,
    mother_name: v('f-mother-name') || null, mother_profession: v('f-mother-profession') || null,
    mother_designation: v('f-mother-designation') || null, mother_education: v('f-mother-education') || null,
    mother_contact: v('f-mother-contact') || null, mother_nid: v('f-mother-nid') || null,
    mother_office_address: v('f-mother-office') || null, mother_yearly_income: v('f-mother-income') || null,
    mother_photo: document.getElementById('f-mother-photo')?.value || null,
    guardian_name: v('f-guardian-name') || null, guardian_profession: v('f-guardian-profession') || null,
    guardian_designation: v('f-guardian-designation') || null, guardian_education: v('f-guardian-education') || null,
    guardian_contact: v('f-guardian-contact') || null, guardian_relation: v('f-guardian-relation') || null,
    guardian_office_address: v('f-guardian-office') || null,
    guardian_photo: document.getElementById('f-guardian-photo')?.value || null
  };
}

async function saveApplication() {
  const data = collectForm();
  if (!data.name_english) { toast('Please enter student name', 'warn'); showSection('s-student', document.querySelectorAll('.ftab')[1]); return; }
  setLoading(true);
  const res = await api('saveApplication', { id: currentId, data });
  setLoading(false);
  if (res.error) { toast(res.error, 'error'); return; }
  if (!currentId) currentId = res.id;
  toast('Saved successfully', 'success');
  // Update hidden fields with any generated IDs
  if (!v('f-tracking-id')) {
    const gr = await api('getApplication', { id: currentId });
    if (gr.application) {
      setV('f-tracking-id', gr.application.tracking_id);
      setV('f-index-id', gr.application.index_id);
    }
  }
}

/* ─── Photo upload ────────────────────────────────────── */
function handlePhoto(input, previewId, hiddenId) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    document.getElementById(hiddenId).value = dataUrl;
    const prev = document.getElementById(previewId);
    prev.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover">`;
  };
  reader.readAsDataURL(file);
}

/* ─── Print ──────────────────────────────────────────── */
async function printFromList(id) {
  setLoading(true);
  const res = await api('getApplication', { id });
  setLoading(false);
  if (!res.application) { toast('Not found', 'error'); return; }
  openPrintWindow(res.application);
}

function printCurrent() {
  const data = collectForm();
  openPrintWindow(data);
}

function openPrintWindow(a) {
  const LOGO = 'https://lh3.googleusercontent.com/d/1Gb6gpcw1moYPAh9hSZ7cEQ5vgXxHj8LB';
  const fmtDate = d => { if (!d) return ''; try { const dt = new Date(d); return dt.toLocaleDateString('en-BD'); } catch { return d; } };
  const row = (label, value) => `<tr><td class="pr-lbl">${label}</td><td class="pr-val">${value || ''}</td></tr>`;

  const studentSection = `
    <div class="pr-section">
      <div class="pr-sec-hdr">Applicant's Information</div>
      <div class="pr-body">
        <div class="pr-fields-photo">
          <div class="pr-fields">
            <table class="pr-table">
              ${row("Name (English)", `<strong>${a.name_english||''}</strong>`)}
              ${row("নাম (বাংলায়)", a.name_bangla)}
              ${row("Date of Birth", fmtDate(a.date_of_birth))}
              ${row("Blood Group", a.blood_group)}
              ${row("Gender", a.gender)}
              ${row("Religion", a.religion)}
              ${row("Birth Reg. No.", a.birth_reg_no)}
              ${row("Nationality", a.nationality || 'Bangladeshi')}
              ${row("Emergency Contact", a.emergency_contact)}
              ${row("Height (Inch)", a.height)}
              ${row("Co-curricular Activities", a.co_curricular)}
              ${row("Last Institute", a.last_institute)}
              ${row("Last Class / Version", `${a.last_class||''}  ${a.last_version||''}`)}
              ${row("Present Address", a.present_address)}
              ${row("Permanent Address", a.permanent_address)}
            </table>
          </div>
          <div class="pr-photo-box">
            ${a.student_photo ? `<img src="${a.student_photo}" class="pr-photo">` : '<div class="pr-photo-empty">Photo</div>'}
          </div>
        </div>
      </div>
    </div>`;

  const fatherSection = `
    <div class="pr-section">
      <div class="pr-sec-hdr">Father's Details</div>
      <div class="pr-body">
        <div class="pr-fields-photo">
          <div class="pr-fields">
            <table class="pr-table">
              ${row("Name", `<strong>${a.father_name||''}</strong>`)}
              ${row("Profession / Occupation", a.father_profession)}
              ${row("Designation / Rank", a.father_designation)}
              ${row("Education", a.father_education)}
              ${row("Contact No.", a.father_contact)}
              ${row("NID", a.father_nid)}
              ${row("Office Address / Unit", a.father_office_address)}
              ${row("Yearly Income (BDT)", a.father_yearly_income)}
            </table>
          </div>
          <div class="pr-photo-box">
            ${a.father_photo ? `<img src="${a.father_photo}" class="pr-photo">` : '<div class="pr-photo-empty">Photo</div>'}
          </div>
        </div>
      </div>
    </div>`;

  const motherSection = `
    <div class="pr-section">
      <div class="pr-sec-hdr">Mother's Details</div>
      <div class="pr-body">
        <div class="pr-fields-photo">
          <div class="pr-fields">
            <table class="pr-table">
              ${row("Name", `<strong>${a.mother_name||''}</strong>`)}
              ${row("Profession / Occupation", a.mother_profession)}
              ${row("Designation / Rank", a.mother_designation)}
              ${row("Education", a.mother_education)}
              ${row("Contact No.", a.mother_contact)}
              ${row("NID", a.mother_nid)}
              ${row("Office Address / Unit", a.mother_office_address)}
              ${row("Yearly Income (BDT)", a.mother_yearly_income)}
            </table>
          </div>
          <div class="pr-photo-box">
            ${a.mother_photo ? `<img src="${a.mother_photo}" class="pr-photo">` : '<div class="pr-photo-empty">Photo</div>'}
          </div>
        </div>
      </div>
    </div>`;

  const guardianSection = `
    <div class="pr-section">
      <div class="pr-sec-hdr">Local Guardian's Details</div>
      <div class="pr-body">
        <div class="pr-fields-photo">
          <div class="pr-fields">
            <table class="pr-table">
              ${row("Name", `<strong>${a.guardian_name||''}</strong>`)}
              ${row("Profession / Occupation", a.guardian_profession)}
              ${row("Designation / Rank", a.guardian_designation)}
              ${row("Education", a.guardian_education)}
              ${row("Contact No.", a.guardian_contact)}
              ${row("Relation to Student", a.guardian_relation)}
              ${row("Office Address / Unit", a.guardian_office_address)}
            </table>
          </div>
          <div class="pr-photo-box">
            ${a.guardian_photo ? `<img src="${a.guardian_photo}" class="pr-photo">` : '<div class="pr-photo-empty">Photo</div>'}
          </div>
        </div>
      </div>
    </div>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Application Form — ${a.tracking_id || ''}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #111; background:#fff; }
  /* ── Page ── */
  @page { size: A4 portrait; margin: 12mm 12mm 16mm 12mm; }
  /* ── Print Header ── */
  .pr-header { display:flex; align-items:center; justify-content:space-between; border-bottom: 2px solid #1a2b5c; padding-bottom:8px; margin-bottom:6px; }
  .pr-header-center { text-align:center; flex:1; }
  .pr-college-name { font-size:15pt; font-weight:900; color:#1a2b5c; letter-spacing:0.5px; line-height:1.2; }
  .pr-college-addr { font-size:8pt; color:#444; margin-top:2px; }
  .pr-form-badge { margin-top:5px; display:inline-block; border:1.5px solid #1a2b5c; padding:3px 16px; font-size:10pt; font-weight:900; color:#1a2b5c; letter-spacing:1px; text-transform:uppercase; }
  .pr-logo { width:62px; height:62px; object-fit:contain; }
  .pr-qr { width:55px; height:55px; border:1px solid #ddd; display:flex; align-items:center; justify-content:center; font-size:6pt; color:#888; text-align:center; flex-direction:column; }
  /* ── Index bar ── */
  .pr-index-bar { background:#1a2b5c; color:#fff; display:flex; align-items:center; margin:6px 0; border-radius:3px; overflow:hidden; }
  .pr-index-cell { flex:1; padding:5px 8px; font-size:8pt; font-weight:900; border-right:1px solid rgba(255,255,255,0.2); }
  .pr-index-cell:last-child { border-right:none; }
  .pr-index-label { font-size:6.5pt; font-weight:400; text-transform:uppercase; letter-spacing:0.5px; opacity:.7; display:block; }
  /* ── Sections ── */
  .pr-section { margin-bottom: 6px; border: 1px solid #c8c8c8; border-radius:2px; overflow:hidden; }
  .pr-sec-hdr { background:#e8e8e8; padding:4px 10px; font-size:9pt; font-weight:900; color:#1a2b5c; text-transform:uppercase; letter-spacing:0.5px; border-bottom:1px solid #ccc; }
  .pr-body { padding:6px 8px; }
  .pr-fields-photo { display:flex; gap:10px; }
  .pr-fields { flex:1; }
  .pr-photo-box { flex-shrink:0; width:88px; display:flex; flex-direction:column; align-items:center; justify-content:flex-start; }
  .pr-photo { width:80px; height:90px; object-fit:cover; border:1px solid #bbb; display:block; }
  .pr-photo-empty { width:80px; height:90px; border:1px solid #bbb; display:flex; align-items:center; justify-content:center; font-size:7pt; color:#999; text-align:center; }
  /* ── Table ── */
  .pr-table { width:100%; border-collapse:collapse; }
  .pr-lbl { font-size:8pt; color:#555; padding:2px 6px 2px 0; white-space:nowrap; width:38%; vertical-align:top; }
  .pr-val { font-size:8.5pt; color:#111; padding:2px 0; vertical-align:top; border-bottom:0.5px solid #eee; }
  /* ── Terms ── */
  .pr-terms { border:1px solid #bbb; padding:7px 10px; margin:6px 0; font-size:7.5pt; color:#333; border-radius:2px; }
  .pr-terms-title { font-weight:900; font-size:8pt; margin-bottom:4px; color:#1a2b5c; }
  .pr-terms ul { padding-left:14px; }
  .pr-terms li { margin-bottom:3px; line-height:1.4; }
  /* ── Signature ── */
  .pr-sign-area { display:flex; justify-content:flex-end; margin-top:6px; }
  .pr-sign-box { text-align:center; }
  .pr-sign-line { border-top:1px solid #333; width:160px; margin-bottom:3px; }
  .pr-sign-label { font-size:7.5pt; color:#555; }
  /* ── Footer ── */
  .pr-footer { position:fixed; bottom:0; left:0; right:0; text-align:center; font-size:7pt; color:#999; padding:4px; border-top:0.5px solid #ddd; }
  @media screen { body { background:#e0e0e0; } .pr-page { max-width:210mm; margin:10mm auto; background:#fff; padding:12mm; box-shadow:0 2px 20px rgba(0,0,0,.2); } }
</style>
</head>
<body>
<div class="pr-page">
  <!-- Header -->
  <div class="pr-header">
    <img src="${LOGO}" class="pr-logo" alt="CCPC Logo">
    <div class="pr-header-center">
      <div class="pr-college-name">Chattogram Cantonment Public College</div>
      <div class="pr-college-addr">Zahir Raihan Road, Cantonment, Chattogram — 4220<br>Phone: 031-650500 | Web: ccpc.edu.bd</div>
      <div class="pr-form-badge">Application Form — Session ${a.session || new Date().getFullYear()}</div>
    </div>
    <div class="pr-qr">
      <svg width="50" height="50" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="20" height="20" rx="1" fill="none" stroke="#333" stroke-width="1.5"/>
        <rect x="4" y="4" width="14" height="14" fill="#333"/>
        <rect x="6" y="6" width="10" height="10" fill="white"/>
        <rect x="8" y="8" width="6" height="6" fill="#333"/>
        <rect x="29" y="1" width="20" height="20" rx="1" fill="none" stroke="#333" stroke-width="1.5"/>
        <rect x="32" y="4" width="14" height="14" fill="#333"/>
        <rect x="34" y="6" width="10" height="10" fill="white"/>
        <rect x="36" y="8" width="6" height="6" fill="#333"/>
        <rect x="1" y="29" width="20" height="20" rx="1" fill="none" stroke="#333" stroke-width="1.5"/>
        <rect x="4" y="32" width="14" height="14" fill="#333"/>
        <rect x="6" y="34" width="10" height="10" fill="white"/>
        <rect x="8" y="36" width="6" height="6" fill="#333"/>
        <rect x="29" y="25" width="5" height="5" fill="#333"/>
        <rect x="35" y="25" width="5" height="5" fill="#333"/>
        <rect x="41" y="25" width="9" height="5" fill="#333"/>
        <rect x="29" y="32" width="21" height="4" fill="#333"/>
        <rect x="29" y="38" width="9" height="4" fill="#333"/>
        <rect x="40" y="38" width="10" height="4" fill="#333"/>
        <rect x="29" y="44" width="5" height="5" fill="#333"/>
        <rect x="38" y="44" width="12" height="5" fill="#333"/>
      </svg>
      <span style="font-size:6pt;color:#888;margin-top:2px;">${a.tracking_id||''}</span>
    </div>
  </div>

  <!-- Index Bar -->
  <div class="pr-index-bar">
    <div class="pr-index-cell">
      <span class="pr-index-label">Index ID</span>
      ${a.index_id || '—'}
    </div>
    <div class="pr-index-cell">
      <span class="pr-index-label">Class</span>
      ${a.class || '—'}
    </div>
    <div class="pr-index-cell">
      <span class="pr-index-label">Category</span>
      ${a.category || '—'}
    </div>
    <div class="pr-index-cell">
      <span class="pr-index-label">Version</span>
      ${a.version || '—'}
    </div>
    <div class="pr-index-cell">
      <span class="pr-index-label">Quota</span>
      ${a.quota || 'No'}
    </div>
  </div>

  ${studentSection}
  ${fatherSection}
  ${motherSection}
  ${guardianSection}

  <!-- Terms -->
  <div class="pr-terms">
    <div class="pr-terms-title">Terms &amp; Conditions</div>
    <ul>
      <li>I hereby declare that all information provided in this application is true and correct to the best of my knowledge. Any false information may result in cancellation of admission.</li>
      <li>I agree to abide by all rules and regulations of Chattogram Cantonment Public College. The authority reserves the right to cancel admission if any irregularity is found.</li>
    </ul>
  </div>

  <!-- Signature -->
  <div class="pr-sign-area">
    <div class="pr-sign-box">
      <div style="height:30px;"></div>
      <div class="pr-sign-line"></div>
      <div class="pr-sign-label">Guardian's Signature &amp; Date</div>
    </div>
  </div>

  <!-- Footer -->
  <div class="pr-footer">
    Chattogram Cantonment Public College — Official Admission Form — Page 1 of 1
  </div>
</div>
<script>window.onload = () => window.print();<\/script>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=900,height=1100');
  w.document.write(html);
  w.document.close();
}

/* ─── Keyboard shortcuts ─────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeConfirm(false);
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    const fv = document.getElementById('view-form');
    if (fv && !fv.classList.contains('hidden')) saveApplication();
  }
});
