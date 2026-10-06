/***** MOVE Faults – Digital Logsheet PWA (Day 2) *****/

const API_URL = window.LS_CONFIG.API_URL;
const PARTY = ['ABB','ERPE','NJTM','PPG','RDR','ADSP','ARLA','RAEN','ARP','CJVC','PDFB','TCB','ZAGR'];
const EQ_ROWS = [
  // key, label, prefill field in station data (null = no prefill)
  ['receiverType',   'Receiver type',        'receiverModel'],
  ['receiverSerial', 'Receiver serial no.',  'receiverSerial'],
  ['antennaType',    'Antenna type',         'antennaModel'],
  ['antennaPart',    'Antenna part no.',     null],
  ['antennaSerial',  'Antenna serial no.',   'antennaSerial'],
  ['antennaHeight',  'Antenna height (m)',   null]
];

const $app = document.getElementById('app');
const S = { session: null, stations: [], stationsAt: null, draft: null };

/* ---------- Helpers ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s == null ? '' : s).trim().toUpperCase();
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fmtDate = ms => ms ? new Date(ms).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const tokenValid = () => !!(S.session && S.session.token && S.session.expires > Date.now());
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
const setPath = (obj, path, val) => {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach(k => { if (!o[k]) o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = val;
};

/* ---------- IndexedDB (data stays on the phone) ---------- */
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mf-logsheet', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('kv');
      d.createObjectStore('drafts', { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const kvGet = k => idb('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => idb('kv', 'readwrite', s => s.put(v, k));
const draftsAll = () => idb('drafts', 'readonly', s => s.getAll());
const draftPut = d => idb('drafts', 'readwrite', s => s.put(d));
const draftDel = id => idb('drafts', 'readwrite', s => s.delete(id));

/* ---------- API ---------- */
async function api(action, data) {
  const body = Object.assign({ action: action, token: S.session ? S.session.token : null }, data || {});
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('Server did not reply with data. Check the web app URL in config.js and that the deployment is updated (HTTP ' + res.status + ').'); }
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json;
}

async function refreshStations(silent) {
  if (!navigator.onLine || !tokenValid()) return;
  try {
    const r = await api('getStations');
    S.stations = r.stations;
    S.stationsAt = Date.now();
    await kvSet('stations', S.stations);
    await kvSet('stationsAt', S.stationsAt);
    if (!S.draft) showHome();
  } catch (err) {
    if (err.message === 'Session expired') {
      S.session.expires = 0;
      await kvSet('session', S.session);
      if (!S.draft) showHome();
    } else if (!silent) {
      alert('Could not refresh stations: ' + err.message);
    }
  }
}

/* ---------- Network indicator ---------- */
function updateNet() {
  const el = document.getElementById('net');
  el.className = 'net ' + (navigator.onLine ? 'on' : 'off');
  el.textContent = navigator.onLine ? 'Online' : 'Offline';
}
window.addEventListener('online', () => { updateNet(); refreshStations(true); });
window.addEventListener('offline', updateNet);

/* ---------- Login ---------- */
function showLogin(msg) {
  S.draft = null;
  document.body.classList.add('login-mode');
  const lastUser = S.session ? S.session.user : '';
  $app.innerHTML = `
    <div class="login-wrap">
      <img class="logo-top" src="logo-top.png" alt="MOVE Faults" onerror="this.style.display='none'">
      <div class="login-card">
        <div class="login-head">
          <h1>SIGN IN</h1>
          <p>Digital Logsheet</p>
        </div>
        <div class="login-body">
          <label for="u">USERNAME</label>
          <input id="u" placeholder="Enter username" autocomplete="username" autocapitalize="characters" value="${esc(lastUser)}">
          <label for="p">PASSWORD</label>
          <input id="p" type="password" placeholder="Enter password" autocomplete="current-password">
          <button class="btn" id="go">Log in</button>
          <div class="msg err" id="msg">${esc(msg || '')}</div>
        </div>
      </div>
      <img class="logo-footer" src="logo-footer.png" alt="DOST-PHIVOLCS" onerror="this.style.display='none'">
    </div>`;
  const u = document.getElementById('u'), p = document.getElementById('p'), go = document.getElementById('go');
  u.addEventListener('keydown', e => { if (e.key === 'Enter') p.focus(); });
  p.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
  go.onclick = async () => {
    const m = document.getElementById('msg');
    if (!navigator.onLine) { m.textContent = 'You need signal to log in. Drafts already on this phone are safe.'; return; }
    go.disabled = true; go.textContent = 'Checking...'; m.textContent = '';
    try {
      const r = await api('login', { username: u.value, password: p.value });
      S.session = { token: r.token, user: r.user, roles: r.roles, expires: Date.now() + r.hours * 3600 * 1000 };
      await kvSet('session', S.session);
      go.textContent = 'Loading stations...';
      await refreshStations(false);
      showHome();
    } catch (err) {
      m.textContent = err.message === 'Failed to fetch'
        ? 'Could not reach the server. Check your signal and the web app URL in config.js.'
        : err.message;
      go.disabled = false; go.textContent = 'Log in';
    }
  };
}

async function logout() {
  if (!confirm('Log out? Drafts stay saved on this phone.')) return;
  S.session = null;
  await kvSet('session', null);
  showLogin();
}

/* ---------- Home ---------- */
async function showHome() {
  S.draft = null;
  document.body.classList.remove('login-mode');
  const drafts = (await draftsAll()).sort((a, b) => b.updatedAt - a.updatedAt);
  const expired = !tokenValid();
  $app.innerHTML = `
    ${expired ? `<div class="banner">Your session has ended. You can keep filling drafts offline. <a href="#" id="relog" style="color:inherit;font-weight:700">Log in again</a> to sync.</div>` : ''}
    <div class="between" style="margin-bottom:12px">
      <div class="white">Hi, <b>${esc(S.session.user)}</b> <span class="pill">${esc((S.session.roles || []).join(', '))}</span></div>
      <button class="btn small ghost" id="out">Log out</button>
    </div>
    <button class="btn" id="new">New Log Sheet</button>
    <div class="card" style="margin-top:14px">
      <div class="between">
        <h2 style="margin:0">Drafts on this phone</h2>
        <span class="pill">${drafts.length}</span>
      </div>
      ${drafts.length ? drafts.map(d => `
        <button class="list-item" data-open="${esc(d.id)}">
          <div class="between"><b>${esc(d.siteCode)}</b><span class="pill">${esc(d.status)}</span></div>
          <div class="muted">${esc(d.visit.address || '')}</div>
          <div class="muted">Visit: ${esc((d.visit.datetime || '').replace('T', ' '))} · Edited ${esc(fmtDate(d.updatedAt))}</div>
        </button>`).join('') : '<p class="muted">No drafts yet.</p>'}
    </div>
    <div class="card">
      <div class="between">
        <div>
          <b>${S.stations.length}</b> <span class="muted">stations saved for offline use</span>
          <div class="muted">Updated ${esc(fmtDate(S.stationsAt))}</div>
        </div>
        <button class="btn small ghost" id="ref">Refresh</button>
      </div>
    </div>`;
  document.getElementById('out').onclick = logout;
  document.getElementById('new').onclick = showPicker;
  document.getElementById('ref').onclick = async () => {
    if (!navigator.onLine) return alert('No signal. Stations will refresh when you are back online.');
    if (!tokenValid()) return showLogin('Session ended. Log in to refresh.');
    await refreshStations(false);
  };
  const relog = document.getElementById('relog');
  if (relog) relog.onclick = e => { e.preventDefault(); showLogin(); };
  $app.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
    const d = (await draftsAll()).find(x => x.id === b.dataset.open);
    if (d) showForm(d);
  });
}

/* ---------- Station picker ---------- */
function showPicker() {
  if (!S.stations.length) {
    alert('No stations saved yet. Connect to signal and tap Refresh.');
    return;
  }
  $app.innerHTML = `
    <button class="btn small ghost" id="back">← Back</button>
    <div class="card" style="margin-top:12px">
      <h2>Choose station</h2>
      <input id="q" placeholder="Code, alias, municipality or province" autocomplete="off">
      <div id="results"></div>
    </div>`;
  document.getElementById('back').onclick = showHome;
  const q = document.getElementById('q'), out = document.getElementById('results');
  const render = () => {
    const t = norm(q.value);
    const hits = S.stations.filter(s => !t ||
      [s.code, s.alias, s.city, s.province].some(x => norm(x).includes(t))).slice(0, 60);
    out.innerHTML = hits.map(s => `
      <button class="list-item" data-code="${esc(s.code)}">
        <div class="between"><b>${esc(s.code)}${s.alias ? ' / ' + esc(s.alias) : ''}</b><span class="pill">${esc(s.status)}</span></div>
        <div class="muted">${esc(s.address)}</div>
        <div class="muted">Last visit: ${esc(s.lastVisit || '—')}</div>
      </button>`).join('') || '<p class="muted">No match.</p>';
    out.querySelectorAll('[data-code]').forEach(b => b.onclick = () => startDraft(b.dataset.code));
  };
  q.oninput = render;
  render();
  q.focus();
}

async function startDraft(code) {
  const st = S.stations.find(s => s.code === code);
  const now = Date.now();
  const d = {
    id: crypto.randomUUID(),
    siteCode: st.code,
    status: 'Draft',
    createdBy: S.session.user,
    createdAt: now,
    updatedAt: now,
    prefill: st,
    visit: {
      address: st.address,
      datetime: localNow(),
      party: PARTY.includes(S.session.user) ? [S.session.user] : []
    },
    equipment: {
      before: {
        receiverType: st.receiverModel, receiverSerial: st.receiverSerial,
        antennaType: st.antennaModel, antennaPart: '', antennaSerial: st.antennaSerial, antennaHeight: ''
      },
      after: { receiverType: '', receiverSerial: '', antennaType: '', antennaPart: '', antennaSerial: '', antennaHeight: '' },
      powerFailure: ''
    },
    mismatches: []
  };
  await draftPut(d);
  showForm(d);
}

/* ---------- Form (Sections A–B) ---------- */
let saveTimer;
function scheduleSave() {
  const el = document.getElementById('saved');
  if (el) el.textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    S.draft.updatedAt = Date.now();
    await draftPut(S.draft);
    const e2 = document.getElementById('saved');
    if (e2) e2.textContent = 'Saved on this phone · ' + new Date().toLocaleTimeString('en-PH', { timeStyle: 'short' });
  }, 400);
}

function computeMismatches() {
  const d = S.draft, list = [];
  EQ_ROWS.forEach(([key, label, pf]) => {
    if (!pf) return;
    const was = d.prefill[pf] || '', now = d.equipment.before[key] || '';
    const flagged = norm(was) !== norm(now);
    if (flagged) list.push({ field: key, label: label, sitemetadata: was, field_value: now });
    const el = document.getElementById('flag-' + key);
    if (el) el.classList.toggle('show', flagged);
  });
  d.mismatches = list;
}

function showForm(d) {
  S.draft = d;
  const st = d.prefill;
  $app.innerHTML = `
    <div class="between">
      <button class="btn small ghost" id="back">← Home</button>
      <div class="saved" id="saved">Saved on this phone</div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>A. Visit details</h3>
      <div class="between"><h2 style="margin:0">${esc(d.siteCode)}${st.alias ? ' / ' + esc(st.alias) : ''}</h2><span class="pill">${esc(st.status)}</span></div>
      <p class="muted" style="margin:6px 0 0">${esc(st.region)} · Last visit ${esc(st.lastVisit || '—')}</p>
      <label>Address</label>
      <input data-path="visit.address" value="${esc(d.visit.address)}">
      <label>Date and time of visit (local)</label>
      <input type="datetime-local" data-path="visit.datetime" value="${esc(d.visit.datetime)}">
      <label>Field party — tap everyone present</label>
      <div class="chips">${PARTY.map(p => `<button class="chip ${d.visit.party.includes(p) ? 'on' : ''}" data-party="${p}">${p}</button>`).join('')}</div>
      <p class="muted" id="partyCount" style="margin-top:8px">${d.visit.party.length} of ${PARTY.length} selected</p>
    </div>

    <div class="card">
      <h3>B. Equipment</h3>
      <p class="muted" style="margin-top:0">Before is prefilled from SiteMetaData. Correct it if the site has different equipment. Fill After only if something was replaced.</p>
      <table class="eq">
        <thead><tr><th></th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          ${EQ_ROWS.map(([key, label, pf]) => `
            <tr>
              <td class="lbl">${label}</td>
              <td>
                <input data-path="equipment.before.${key}" value="${esc(d.equipment.before[key])}" ${key === 'antennaHeight' ? 'inputmode="decimal"' : ''}>
                ${pf ? `<div class="flag" id="flag-${key}">Differs from SiteMetaData: ${esc(st[pf] || '(blank)')}</div>` : ''}
              </td>
              <td><input data-path="equipment.after.${key}" value="${esc(d.equipment.after[key])}" ${key === 'antennaHeight' ? 'inputmode="decimal"' : ''}></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <label>Power failure?</label>
      <div class="yn" data-yn="equipment.powerFailure">
        <button data-v="Yes" class="${d.equipment.powerFailure === 'Yes' ? 'on' : ''}">Yes</button>
        <button data-v="No" class="${d.equipment.powerFailure === 'No' ? 'on' : ''}">No</button>
      </div>
    </div>

    <div class="todo">Sections C–L (checklists, photos, contact person, station status, Submit) arrive in Week 2.</div>
    <button class="btn danger" id="del" style="margin-top:14px">Delete this draft</button>`;

  document.getElementById('back').onclick = () => { clearTimeout(saveTimer); draftPut(S.draft).then(showHome); };
  document.getElementById('del').onclick = async () => {
    if (!confirm('Delete this draft from the phone? This cannot be undone.')) return;
    await draftDel(d.id);
    showHome();
  };

  $app.querySelectorAll('[data-path]').forEach(inp => inp.addEventListener('input', () => {
    setPath(S.draft, inp.dataset.path, inp.value);
    computeMismatches();
    scheduleSave();
  }));

  $app.querySelectorAll('[data-party]').forEach(b => b.onclick = () => {
    const p = b.dataset.party, list = S.draft.visit.party, i = list.indexOf(p);
    if (i === -1) list.push(p); else list.splice(i, 1);
    b.classList.toggle('on', i === -1);
    document.getElementById('partyCount').textContent = list.length + ' of ' + PARTY.length + ' selected';
    scheduleSave();
  });

  $app.querySelectorAll('[data-yn]').forEach(group => group.querySelectorAll('button').forEach(b => b.onclick = () => {
    const path = group.dataset.yn;
    const val = getPath(S.draft, path) === b.dataset.v ? '' : b.dataset.v; // tap again to clear
    setPath(S.draft, path, val);
    group.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === val));
    scheduleSave();
  }));

  computeMismatches();
  window.scrollTo(0, 0);
}

/* ---------- Boot ---------- */
async function boot() {
  updateNet();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  S.session = await kvGet('session');
  S.stations = (await kvGet('stations')) || [];
  S.stationsAt = await kvGet('stationsAt');
  if (!S.session) return showLogin();
  await showHome();
  refreshStations(true);
}
boot();
