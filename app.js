/***** MOVE Faults – Digital Logsheet PWA *****/

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
const SYSTEM_ITEMS = [
  ['receiver', 'Receiver'], ['solarCharger', 'Solar charger'], ['controller', 'Controller'],
  ['exhaustFan', 'Exhaust fan'], ['indicatorLight', 'Indicator light']
];
const CHARGERS = ['AC', 'DC', 'AC/DC', 'Solar'];
const SESSIONS = ['01S_01H', '30S_01H'];
const STATION_STATUSES = ['Active', 'Under Maintenance', 'Decommissioned', 'Archived'];

const $app = document.getElementById('app');
const S = { session: null, stations: [], stationsAt: null, draft: null, screen: '', approvals: [], approvedAll: [] };

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
const emptyQueueMsg = () => (S.session && S.session.user === 'ZAGR') ? 'No approvals at the moment. Relax. Have some BBQ' : 'Nothing waiting. All caught up.';
const isApprover = () => !!(S.session && (S.session.roles || []).some(r => r.toLowerCase() === 'approver'));
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
const setPath = (obj, path, val) => {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach(k => { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = val;
};
const yn = () => ({ ok: '', remarks: '' });

/* ---------- IndexedDB (data stays on the device) ---------- */
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mf-logsheet', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; };          // site data cleared: reopen next time
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}
async function idb(store, mode, fn) {
  try { return await idbOnce(store, mode, fn); }
  catch (e) { _db = null; return idbOnce(store, mode, fn); } // retry once with a fresh connection
}
async function idbOnce(store, mode, fn) {
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
const photosAll = () => idb('photos', 'readonly', s => s.getAll());
const photoPut = p => idb('photos', 'readwrite', s => s.put(p));
const photoDel = id => idb('photos', 'readwrite', s => s.delete(id));
const photosFor = async draftId => (await photosAll()).filter(p => p.draftId === draftId)
  .sort((a, b) => a.addedAt - b.addedAt);

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
  catch (e) { throw new Error('Server did not reply with data (HTTP ' + res.status + ').'); }
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json;
}

async function markExpired() {
  if (!S.session) return;
  S.session.expires = 0;
  await kvSet('session', S.session);
}

async function refreshStations(silent) {
  if (!navigator.onLine || !tokenValid()) return;
  try {
    const r = await api('getStations');
    S.stations = r.stations;
    S.stationsAt = Date.now();
    await kvSet('stations', S.stations);
    await kvSet('stationsAt', S.stationsAt);
    if (S.screen === 'home') showHome();
  } catch (err) {
    if (err.message === 'Session expired') { await markExpired(); if (S.screen === 'home') showHome(); }
    else if (!silent) alert('Could not refresh stations: ' + err.message);
  }
}

/* ---------- Pull this user's logsheets from the server (restores them on a new or cleared device) ---------- */
async function pullMine(items) {
  const r = { items: items };
  const local = {};
  (await draftsAll()).forEach(d => { local[d.id] = d; });
  for (const it of r.items) {
    const ld = local[it.id];
    if (ld && ['Draft', 'Queued'].includes(ld.status)) continue;      // unsent local edits win
    if (ld && ld.serverVersion === it.version && ld.status === it.status && (ld.pdfUrl || '') === it.pdfUrl) continue;
    const x = it.data || {};
    const st = S.stations.find(s => s.code === x.siteCode) || {};
    const d = Object.assign({}, x, {
      id: it.id,
      siteCode: x.siteCode,
      status: it.status,
      serverVersion: it.version,
      createdBy: x.createdBy,
      createdAt: x.createdAt || Date.now(),
      updatedAt: ld ? ld.updatedAt : Date.now(),
      prefill: ld && ld.prefill ? ld.prefill : Object.assign({}, st, x.siteMetaDataSnapshot || {}),
      pdfUrl: it.pdfUrl, pdfDownload: it.pdfDownload, approvedBy: it.approvedBy,
      returnComment: it.returnComment, returnedBy: it.returnedBy,
      mismatches: x.mismatches || []
    });
    d.serverPhotos = x.photos || []; delete d.photos; delete d.siteMetaDataSnapshot;
    await draftPut(ensureShape(d));
  }
}

/* ---------- Server status of sent logsheets ---------- */
async function refreshStatuses() {
  if (!navigator.onLine || !tokenValid()) return;
  try {
    const known = {};
    (await draftsAll()).forEach(d => {
      if (d.serverVersion) known[d.id] = d.serverVersion + '|' + d.status + '|' + (d.pdfUrl || '');
    });
    const r = await api('refresh', { known: known }); // one call; only changed logsheets come back
    await pullMine(r.mine);
    if (isApprover()) {
      S.approvals = r.approvals;
      S.approvedAll = r.approved || [];
      await kvSet('approvedAll', S.approvedAll);
      // a PDF still being made: check again in a minute
      clearTimeout(S.pdfPoll);
      if (S.approvedAll.some(x => !x.pdfUrl)) S.pdfPoll = setTimeout(refreshStatuses, 60000);
    }
    if ((await draftsAll()).some(d => d.status === 'Approved' && !d.pdfUrl)) {
      clearTimeout(S.pdfPoll2); S.pdfPoll2 = setTimeout(refreshStatuses, 60000);
    }
  } catch (err) {
    if (err.message === 'Session expired') await markExpired();
  }
  if (S.screen === 'home') showHome();
}

/* ---------- Sync queue ---------- */
let syncing = false;
function buildPayload(d, photos) {
  const p = d.prefill || {};
  return {
    id: d.id, siteCode: d.siteCode, createdBy: d.createdBy, createdAt: d.createdAt,
    visit: d.visit, equipment: d.equipment, system: d.system, power: d.power,
    network: d.network, receiverConfig: d.receiverConfig, ftp: d.ftp, download: d.download,
    notes: d.notes, contact: d.contact, stationStatusAfter: d.stationStatusAfter,
    mismatches: d.mismatches,
    siteMetaDataSnapshot: {
      status: p.status, receiverModel: p.receiverModel, receiverSerial: p.receiverSerial,
      antennaModel: p.antennaModel, antennaSerial: p.antennaSerial, power: p.power
    },
    photosFolderUrl: d.photosFolderUrl || '',
    photos: (d.serverPhotos || []).filter(sp => !photos.some(x => x.id === sp.id))
      .concat(photos.filter(x => x.uploaded).map(x => ({ id: x.id, group: x.group, url: x.url, fileId: x.fileId })))
  };
}

async function syncOne(d) {
  const visitDate = (d.visit.datetime || '').slice(0, 10) || localNow().slice(0, 10);
  const photos = await photosFor(d.id);
  for (const p of photos) {
    if (p.uploaded) continue;
    const r = await api('uploadPhoto', {
      logsheetId: d.id, siteCode: d.siteCode, folderUrl: (d.prefill || {}).folderUrl || '',
      visitDate: visitDate, photoId: p.id, group: p.group, dataUrl: p.dataUrl
    });
    p.uploaded = true; p.url = r.url; p.fileId = r.fileId;
    d.photosFolderUrl = r.folderUrl;
    await photoPut(p);
  }
  const r = await api('submitLogsheet', { logsheet: buildPayload(d, await photosFor(d.id)) });
  d.status = 'Submitted';
  d.serverVersion = r.version;
  d.syncedAt = Date.now();
  d.syncError = '';
  await draftPut(d);
}

async function syncAll() {
  if (syncing || !navigator.onLine || !tokenValid()) return;
  syncing = true;
  try {
    const queued = (await draftsAll()).filter(d => d.status === 'Queued');
    for (const d of queued) {
      try {
        await syncOne(d);
      } catch (err) {
        if (err.message === 'Session expired') { await markExpired(); break; }
        d.syncError = err.message;
        await draftPut(d);
      }
    }
  } finally {
    syncing = false;
    await refreshStatuses();
  }
}
setInterval(syncAll, 60000);

/* ---------- Network indicator ---------- */
function updateNet() {
  const el = document.getElementById('net');
  el.className = 'net ' + (navigator.onLine ? 'on' : 'off');
  el.textContent = navigator.onLine ? 'Online' : 'Offline';
}
window.addEventListener('online', () => { updateNet(); refreshStations(true); syncAll(); });
window.addEventListener('offline', updateNet);

/* ---------- Login ---------- */
function showLogin(msg) {
  S.draft = null; S.screen = 'login';
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
    if (!navigator.onLine) { m.textContent = 'You need signal to log in. Drafts already on this device are safe.'; return; }
    go.disabled = true; go.textContent = 'Checking...'; m.textContent = '';
    try {
      const r = await api('login', { username: u.value, password: p.value });
      S.session = { token: r.token, user: r.user, roles: r.roles, firstName: r.firstName || r.user, expires: Date.now() + r.hours * 3600 * 1000 };
      await kvSet('session', S.session);
      if (r.stations) {
        S.stations = r.stations; S.stationsAt = Date.now();
        await kvSet('stations', S.stations); await kvSet('stationsAt', S.stationsAt);
      } else {
        go.textContent = 'Loading stations...';
        await refreshStations(false);
      }
      showHome();
      syncAll();
    } catch (err) {
      m.textContent = err.message === 'Failed to fetch'
        ? 'Could not reach the server. Check your signal.'
        : err.message;
      go.disabled = false; go.textContent = 'Log in';
    }
  };
}

async function logout() {
  if (!confirm('Log out? Drafts and unsent logsheets stay saved on this device.')) return;
  S.session = null;
  await kvSet('session', null);
  showLogin();
}

/* ---------- Greeting ---------- */
function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return part + ', ' + ((S.session && (S.session.firstName || S.session.user)) || '');
}

/* ---------- PDF links (always shown for approved logsheets) ---------- */
function pdfLinks(d) {
  if (!d.pdfUrl) return `<div class="pdf-links muted">PDF is being prepared. It will appear here shortly.</div>`;
  const dl = d.pdfDownload || ('https://drive.google.com/uc?export=download&id=' + ((d.pdfUrl.match(/\/d\/([\w-]+)/) || [])[1] || ''));
  return `<div class="pdf-links"><a class="btn small ghost dark" href="${esc(d.pdfUrl)}" target="_blank" rel="noopener">View PDF</a> <a class="btn small ghost dark" href="${esc(dl)}">Download PDF</a></div>`;
}

function approvedArchiveCard() {
  const list = S.approvedAll || [];
  return `
    <div class="card">
      <div class="between"><h2 style="margin:0">Approved logsheets (all)</h2><span class="pill">${list.length}</span></div>
      ${list.length ? list.map(x => `
        <div class="list-item static">
          <div class="between"><b>${esc(x.siteCode)}</b><span class="pill st-Approved">Approved v${x.version}</span></div>
          <div class="muted">Visit: ${esc((x.visit || '').replace('T', ' '))} · By ${esc(x.submittedBy)}</div>
          <div class="muted">Approved by ${esc(x.approvedBy)} on ${esc(x.approvedAt)}</div>
        </div>${pdfLinks(x)}`).join('') : '<p class="muted">No approved logsheets yet.</p>'}
    </div>`;
}

/* ---------- Home ---------- */
function draftCard(d) {
  const label = { Draft: 'Draft', Queued: 'Waiting to sync', Submitted: 'Waiting for approval', Returned: 'Returned', Approved: 'Approved' }[d.status] || d.status;
  return `
    <button class="list-item" data-open="${esc(d.id)}">
      <div class="between"><b>${esc(d.siteCode)}</b><span class="pill st-${esc(d.status)}">${esc(label)}${d.serverVersion ? ' v' + d.serverVersion : ''}</span></div>
      <div class="muted">${esc(d.visit.address || '')}</div>
      <div class="muted">Visit: ${esc((d.visit.datetime || '').replace('T', ' '))} · Edited ${esc(fmtDate(d.updatedAt))}</div>
      ${d.syncError ? `<div class="msg err">Not sent yet: ${esc(d.syncError)}</div>` : ''}

      ${d.status === 'Returned' && d.returnComment ? `<div class="msg err">${esc(d.returnedBy || 'Approver')}: ${esc(d.returnComment)}</div>` : ''}
    </button>${d.status === 'Approved' ? pdfLinks(d) : ''}`;
}

async function showHome() {
  S.draft = null; S.screen = 'home';
  document.body.classList.remove('login-mode');
  const all = (await draftsAll()).sort((a, b) => b.updatedAt - a.updatedAt);
  const drafts = all.filter(d => d.status === 'Draft');
  const queued = all.filter(d => d.status === 'Queued');
  const sent = all.filter(d => d.status === 'Submitted');
  const returned = all.filter(d => d.status === 'Returned');
  const approved = all.filter(d => d.status === 'Approved');
  const expired = !tokenValid();
  $app.innerHTML = `
    ${expired ? `<div class="banner">Your session has ended. You can keep filling logsheets offline. <a href="#" id="relog" style="color:inherit;font-weight:700">Log in again</a> to sync.</div>` : ''}
    <div class="between" style="margin-bottom:6px">
      <h1 class="greet">${esc(greeting())}</h1>
      <button class="btn small ghost" id="out">Log out</button>
    </div>
    <div style="margin-bottom:14px"><span class="pill">${esc((S.session.roles || []).join(', '))}</span></div>
    ${isApprover() ? `
    <div class="card approver-card">
      <div class="between">
        <div><h2 style="margin:0">Approvals</h2>
          <p class="muted" style="margin:4px 0 0">${S.approvals.length ? S.approvals.length + ' logsheet' + (S.approvals.length > 1 ? 's' : '') + ' waiting for your review' : emptyQueueMsg()}</p></div>
        <span class="big-count">${S.approvals.length}</span>
      </div>
      <button class="btn" id="approvals">Review logsheets</button>
    </div>` : ''}
    <button class="btn ${isApprover() ? 'ghost' : ''}" id="new">New Log Sheet</button>
    <div class="stats">
      <div class="stat"><b>${queued.length}</b><span>waiting to sync</span></div>
      <div class="stat"><b>${sent.length}</b><span>waiting for approval</span></div>
    </div>
    ${returned.length ? `
    <div class="card returned">
      <div class="between"><h2 style="margin:0">Returned — needs changes</h2><span class="pill">${returned.length}</span></div>
      ${returned.map(draftCard).join('')}
    </div>` : ''}
    ${queued.length ? `
    <div class="card">
      <div class="between"><h2 style="margin:0">Waiting to sync</h2>
        <button class="btn small ghost dark" id="syncNow" ${syncing ? 'disabled' : ''}>${syncing ? 'Syncing...' : 'Sync now'}</button></div>
      ${queued.map(draftCard).join('')}
    </div>` : ''}
    <div class="card">
      <div class="between"><h2 style="margin:0">Drafts on this device</h2><span class="pill">${drafts.length}</span></div>
      ${drafts.length ? drafts.map(draftCard).join('') : '<p class="muted">No drafts. Tap New Log Sheet to start one.</p>'}
    </div>
    ${sent.length ? `
    <div class="card">
      <div class="between"><h2 style="margin:0">Waiting for approval</h2><span class="pill">${sent.length}</span></div>
      <p class="muted" style="margin:6px 0 0">Open one to correct it and submit changes.</p>
      ${sent.map(draftCard).join('')}
    </div>` : ''}
    ${approved.length ? `
    <div class="card">
      <div class="between"><h2 style="margin:0">Approved</h2><span class="pill">${approved.length}</span></div>
      ${approved.map(draftCard).join('')}
    </div>` : ''}
    ${isApprover() ? approvedArchiveCard() : ''}
    <div class="card">
      <div class="between">
        <div>
          <b>${S.stations.length}</b> <span class="muted">stations saved for offline use</span>
          <div class="muted">Updated ${esc(fmtDate(S.stationsAt))}</div>
        </div>
        <button class="btn small ghost dark" id="ref">Refresh</button>
      </div>
    </div>`;
  document.getElementById('out').onclick = logout;
  document.getElementById('new').onclick = showPicker;
  const ap = document.getElementById('approvals');
  if (ap) ap.onclick = showApprovals;
  document.getElementById('ref').onclick = async () => {
    if (!navigator.onLine) return alert('No signal. Stations will refresh when you are back online.');
    if (!tokenValid()) return showLogin('Session ended. Log in to refresh.');
    await refreshStations(false);
  };
  const sn = document.getElementById('syncNow');
  if (sn) sn.onclick = () => {
    if (!navigator.onLine) return alert('No signal. Logsheets will send automatically when you are back online.');
    if (!tokenValid()) return showLogin('Session ended. Log in to sync.');
    syncAll(); showHome();
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
  S.screen = 'picker';
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

/* ---------- Draft shape ---------- */
function powerPrefill(power) {
  const t = norm(power);
  return {
    battery: t.includes('BATTERY') ? 'With battery' : '',
    batteryStatus: '',
    charger: t.includes('SOLAR') ? ['Solar'] : t.includes('AC TO DC') ? ['AC/DC'] : [],
    chargerStatus: ''
  };
}

function defaultSections(st) {
  return {
    system: { receiver: yn(), solarCharger: yn(), controller: yn(), exhaustFan: yn(), indicatorLight: yn() },
    power: powerPrefill(st.power),
    network: { router: yn(), simReplaced: yn(), loadSufficient: yn() },
    receiverConfig: { logging: yn(), sdCard: { level: '', remarks: '' }, navPosition: { level: '', remarks: '' } },
    ftp: { phivolcs: yn(), namria: yn() },
    download: { sessions: [], details: { '01S_01H': '', '30S_01H': '' }, other: '' },
    notes: '',
    contact: { person: '', number: '', designation: '', email: '' },
    stationStatusAfter: st.status || ''
  };
}

function ensureShape(d) {
  const defs = defaultSections(d.prefill || {});
  Object.keys(defs).forEach(k => { if (d[k] == null) d[k] = defs[k]; });
  if (!d.mismatches) d.mismatches = [];
  if (!d.download.details) d.download.details = { '01S_01H': '', '30S_01H': '' };
  return d;
}

async function startDraft(code) {
  const st = S.stations.find(s => s.code === code);
  const now = Date.now();
  const d = Object.assign({
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
  }, defaultSections(st));
  await draftPut(d);
  showForm(d);
}

/* ---------- Form building blocks ---------- */
const choice = (path, options, cur, cls) => `
  <div class="choice ${cls || ''}" data-choice="${path}">
    ${options.map(o => `<button type="button" data-v="${esc(o)}" class="${o === cur ? 'on' : ''} ${cls === 'lvl' ? 'l-' + o.toLowerCase() : ''}">${esc(o)}</button>`).join('')}
  </div>`;
const multi = (path, options, cur) => `
  <div class="choice" data-multi="${path}">
    ${options.map(o => `<button type="button" data-v="${esc(o)}" class="${(cur || []).includes(o) ? 'on' : ''}">${esc(o)}</button>`).join('')}
  </div>`;
const text = (path, val, ph, type) =>
  `<input data-path="${path}" value="${esc(val)}" placeholder="${esc(ph || '')}" ${type ? 'type="' + type + '"' : ''}>`;
const photoBox = group => `
  <div class="photos">
    <div class="thumbs" id="thumbs-${group}"></div>
    <label class="addphoto">+ Add photo<input type="file" accept="image/*" multiple data-photo="${group}" hidden></label>
  </div>`;
const ynItem = (base, label, obj, photoGroup) => `
  <div class="item">
    <div class="item-label">${label}</div>
    ${choice(base + '.ok', ['Yes', 'No'], obj.ok)}
    ${text(base + '.remarks', obj.remarks, 'Remarks')}
    ${photoGroup ? photoBox(photoGroup) : ''}
  </div>`;
const lvlItem = (base, label, obj) => `
  <div class="item">
    <div class="item-label">${label}</div>
    ${choice(base + '.level', ['Red', 'Orange', 'Green'], obj.level, 'lvl')}
    ${text(base + '.remarks', obj.remarks, 'Remarks')}
  </div>`;

/* ---------- Save + mismatch ---------- */
let saveTimer;
function scheduleSave() {
  const el = document.getElementById('saved');
  if (el) el.textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.draft) return;
  S.draft.updatedAt = Date.now();
  await draftPut(S.draft);
  const el = document.getElementById('saved');
  if (el) el.textContent = 'Saved on this device · ' + new Date().toLocaleTimeString('en-PH', { timeStyle: 'short' });
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
  const stWas = d.prefill.status || '', stNow = d.stationStatusAfter || '';
  const stFlag = norm(stWas) !== norm(stNow);
  if (stFlag) list.push({ field: 'stationStatus', label: 'Station status', sitemetadata: stWas, field_value: stNow });
  const sf = document.getElementById('flag-stationStatus');
  if (sf) sf.classList.toggle('show', stFlag);
  d.mismatches = list;
}

/* ---------- Photos ---------- */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

async function renderThumbs(group) {
  const box = document.getElementById('thumbs-' + group);
  if (!box || !S.draft) return;
  const list = (await photosFor(S.draft.id)).filter(p => p.group === group);
  box.innerHTML = list.map(p => `
    <div class="thumb">
      <img src="${p.dataUrl}" alt="">
      ${p.uploaded ? '<span class="up">Uploaded</span>' : ''}
      <button type="button" data-delphoto="${p.id}" aria-label="Remove photo">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-delphoto]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this photo?')) return;
    await photoDel(b.dataset.delphoto);
    renderThumbs(group);
    scheduleSave();
  });
}

/* ---------- Form ---------- */
function showForm(d) {
  S.draft = ensureShape(d);
  S.screen = 'form';
  const st = d.prefill;
  const submitLabel = d.status === 'Draft' ? 'Submit Log Sheet' : 'Submit changes';
  $app.innerHTML = `
    <div class="between">
      <button class="btn small ghost" id="back">← Home</button>
      <div class="saved" id="saved">Saved on this device</div>
    </div>
    ${d.status === 'Submitted' ? `<div class="banner" style="margin-top:12px">Submitted as v${d.serverVersion || 1}. Changes save on this device; tap <b>Submit changes</b> to send them for approval again.</div>` : ''}
    ${d.status === 'Queued' ? `<div class="banner" style="margin-top:12px">Waiting to sync. Edits you make now will be included when it sends.</div>` : ''}
    ${d.status === 'Returned' ? `<div class="banner danger" style="margin-top:12px"><b>Returned by ${esc(d.returnedBy || 'approver')}:</b> ${esc(d.returnComment || '')}<br>Make the changes, then tap <b>Submit changes</b>.</div>` : ''}
    ${d.status === 'Approved' ? `<div class="banner ok" style="margin-top:12px"><b>Approved${d.approvedBy ? ' by ' + esc(d.approvedBy) : ''}.</b> ${!d.pdfUrl ? 'PDF is being prepared.' : ''}${d.pdfUrl ? `<a href="${esc(d.pdfUrl)}" target="_blank" rel="noopener">Open PDF</a>${d.pdfDownload ? ` · <a href="${esc(d.pdfDownload)}">Download PDF</a>` : ''}.` : ''} Submitting changes sends it for approval again.</div>` : ''}

    <div class="card" style="margin-top:12px">
      <h3>A. Visit details</h3>
      <div class="between"><h2 style="margin:0">${esc(d.siteCode)}${st.alias ? ' / ' + esc(st.alias) : ''}</h2><span class="pill">${esc(st.status)}</span></div>
      <p class="muted" style="margin:6px 0 0">${esc(st.region)} · Last visit ${esc(st.lastVisit || '—')}</p>
      <label>Address</label>
      ${text('visit.address', d.visit.address)}
      <label>Date and time of visit (local)</label>
      <input type="datetime-local" data-path="visit.datetime" value="${esc(d.visit.datetime)}">
      <label>Field party — tap everyone present</label>
      <div class="chips">${PARTY.map(p => `<button type="button" class="chip ${d.visit.party.includes(p) ? 'on' : ''}" data-party="${p}">${p}</button>`).join('')}</div>
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
      ${choice('equipment.powerFailure', ['Yes', 'No'], d.equipment.powerFailure)}
    </div>

    <div class="card">
      <h3>C. System check</h3>
      <p class="muted" style="margin-top:0">Are the following functional?</p>
      ${SYSTEM_ITEMS.map(([k, label]) => ynItem('system.' + k, label, d.system[k])).join('')}
    </div>

    <div class="card">
      <h3>D. Power source check</h3>
      <div class="item">
        <div class="item-label">Battery</div>
        ${choice('power.battery', ['With battery', 'Without battery'], d.power.battery)}
        ${text('power.batteryStatus', d.power.batteryStatus, 'Battery status (e.g. 12.6 V, good)')}
      </div>
      <div class="item">
        <div class="item-label">Charger type — tick all that apply</div>
        ${multi('power.charger', CHARGERS, d.power.charger)}
        ${text('power.chargerStatus', d.power.chargerStatus, 'Charger status')}
      </div>
    </div>

    <div class="card">
      <h3>E. Network connectivity check</h3>
      ${ynItem('network.router', 'Router functional?', d.network.router)}
      ${ynItem('network.simReplaced', 'SIM replacement done?', d.network.simReplaced, 'simReplaced')}
      ${ynItem('network.loadSufficient', 'Prepaid load sufficient?', d.network.loadSufficient, 'loadSufficient')}
    </div>

    <div class="card">
      <h3>F. Receiver configuration check</h3>
      ${ynItem('receiverConfig.logging', 'Is the unit logging?', d.receiverConfig.logging)}
      ${lvlItem('receiverConfig.sdCard', 'SD card storage indicator', d.receiverConfig.sdCard)}
      ${lvlItem('receiverConfig.navPosition', 'Navigated position indicator', d.receiverConfig.navPosition)}
    </div>

    <div class="card">
      <h3>G. FTP push test</h3>
      ${ynItem('ftp.phivolcs', 'PHIVOLCS passed?', d.ftp.phivolcs)}
      ${ynItem('ftp.namria', 'NAMRIA passed?', d.ftp.namria)}
    </div>

    <div class="card">
      <h3>H. Data downloading</h3>
      <div class="item">
        <div class="item-label">Logging sessions downloaded</div>
        ${multi('download.sessions', SESSIONS, d.download.sessions)}
      </div>
      ${SESSIONS.map(s => `
      <div class="item">
        <div class="item-label">${s} details</div>
        <textarea data-path="download.details.${s}" rows="2" placeholder="e.g. files, date range, size">${esc(d.download.details[s] || '')}</textarea>
      </div>`).join('')}
      <div class="item">
        <div class="item-label">Other sessions and remarks</div>
        ${text('download.other', d.download.other, 'Other sessions and remarks')}
      </div>
    </div>

    <div class="card">
      <h3>I. Notes</h3>
      <textarea data-path="notes" rows="5" placeholder="Findings and recommendations">${esc(d.notes)}</textarea>
    </div>

    <div class="card">
      <h3>J. Contact person</h3>
      <label>Name</label>${text('contact.person', d.contact.person)}
      <label>Contact number</label>${text('contact.number', d.contact.number, '', 'tel')}
      <label>Designation</label>${text('contact.designation', d.contact.designation)}
      <label>Email</label>${text('contact.email', d.contact.email, '', 'email')}
    </div>

    <div class="card">
      <h3>K. Site photos</h3>
      ${photoBox('sitePhotos')}
    </div>

    <div class="card">
      <h3>L. Submit</h3>
      <label>Station status after visit</label>
      <select data-path="stationStatusAfter">
        <option value="">Choose...</option>
        ${STATION_STATUSES.map(s => `<option ${s === d.stationStatusAfter ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <div class="flag" id="flag-stationStatus">Differs from SiteMetaData: ${esc(st.status || '(blank)')}</div>
      <button class="btn" id="submit">${submitLabel}</button>
      <p class="muted" style="margin-bottom:0">With no signal, it waits on this device and sends automatically later.</p>
    </div>

    <button class="btn danger" id="del">Delete from this device</button>`;

  /* navigation */
  document.getElementById('back').onclick = async () => { await saveNow(); showHome(); };
  document.getElementById('del').onclick = async () => {
    const extra = ['Submitted', 'Returned', 'Approved'].includes(d.status) ? ' The copy already sent to the server stays.' : '';
    if (!confirm('Delete this logsheet from the device? This cannot be undone.' + extra)) return;
    for (const p of await photosFor(d.id)) await photoDel(p.id);
    await draftDel(d.id);
    showHome();
  };
  document.getElementById('submit').onclick = async () => {
    const msg = d.status === 'Draft' ? 'Submit this logsheet?' : 'Submit your changes for approval again?';
    if (!confirm(msg)) return;
    S.draft.status = 'Queued';
    S.draft.queuedAt = Date.now();
    S.draft.syncError = '';
    await saveNow();
    showHome();
    syncAll();
  };

  /* text inputs, textareas, selects */
  $app.querySelectorAll('[data-path]').forEach(inp => {
    const handler = () => { setPath(S.draft, inp.dataset.path, inp.value); computeMismatches(); scheduleSave(); };
    inp.addEventListener('input', handler);
    if (inp.tagName === 'SELECT') inp.addEventListener('change', handler);
  });

  /* field party */
  $app.querySelectorAll('[data-party]').forEach(b => b.onclick = () => {
    const p = b.dataset.party, list = S.draft.visit.party, i = list.indexOf(p);
    if (i === -1) list.push(p); else list.splice(i, 1);
    b.classList.toggle('on', i === -1);
    document.getElementById('partyCount').textContent = list.length + ' of ' + PARTY.length + ' selected';
    scheduleSave();
  });

  /* single choice (tap again to clear) */
  $app.querySelectorAll('[data-choice]').forEach(group => group.querySelectorAll('button').forEach(b => b.onclick = () => {
    const path = group.dataset.choice;
    const val = getPath(S.draft, path) === b.dataset.v ? '' : b.dataset.v;
    setPath(S.draft, path, val);
    group.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === val));
    scheduleSave();
  }));

  /* multi choice */
  $app.querySelectorAll('[data-multi]').forEach(group => group.querySelectorAll('button').forEach(b => b.onclick = () => {
    const path = group.dataset.multi;
    const list = (getPath(S.draft, path) || []).slice();
    const i = list.indexOf(b.dataset.v);
    if (i === -1) list.push(b.dataset.v); else list.splice(i, 1);
    setPath(S.draft, path, list);
    b.classList.toggle('on', i === -1);
    scheduleSave();
  }));

  /* photos */
  $app.querySelectorAll('[data-photo]').forEach(inp => {
    renderThumbs(inp.dataset.photo);
    inp.onchange = async () => {
      const group = inp.dataset.photo;
      for (const file of Array.from(inp.files || [])) {
        try {
          const dataUrl = await compressImage(file);
          await photoPut({ id: crypto.randomUUID(), draftId: S.draft.id, group: group, dataUrl: dataUrl, uploaded: false, addedAt: Date.now() });
        } catch (err) { alert(err.message); }
      }
      inp.value = '';
      renderThumbs(group);
      scheduleSave();
    };
  });

  computeMismatches();
  window.scrollTo(0, 0);
}

/* ---------- Approvals (Approver role) ---------- */
async function showApprovals() {
  S.screen = 'approvals';
  $app.innerHTML = `
    <button class="btn small ghost" id="back">← Home</button>
    <div class="card" style="margin-top:12px">
      <h2>Waiting for approval</h2>
      <div id="alist"><p class="muted">Loading...</p></div>
    </div>`;
  document.getElementById('back').onclick = showHome;
  const box = document.getElementById('alist');
  if (!navigator.onLine) { box.innerHTML = '<p class="muted">Approvals need signal. Connect and try again.</p>'; return; }
  if (!tokenValid()) return showLogin('Session ended. Log in to review approvals.');
  try {
    const r = await api('listForApproval');
    S.approvals = r.items;
  } catch (err) {
    if (err.message === 'Session expired') { await markExpired(); return showLogin('Session ended. Log in to review approvals.'); }
    box.innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
    return;
  }
  if (S.screen !== 'approvals') return;
  box.innerHTML = S.approvals.length ? S.approvals.map(it => `
    <button class="list-item" data-review="${esc(it.id)}">
      <div class="between"><b>${esc(it.siteCode)}</b><span class="pill">v${it.version}</span></div>
      <div class="muted">Visit: ${esc(it.visit)} · ${esc(it.party)}</div>
      <div class="muted">Submitted by ${esc(it.submittedBy)} on ${esc(it.submittedAt)}</div>
      ${it.flags ? `<div class="flag show">${(it.data.mismatches || []).length} difference(s) from SiteMetaData</div>` : ''}
    </button>`).join('') : `<p class="muted">${esc(emptyQueueMsg())}</p>`;
  box.querySelectorAll('[data-review]').forEach(b => b.onclick = () => showReview(S.approvals.find(x => x.id === b.dataset.review)));
}

function summaryHtml(x) {
  const row = (l, v) => `<div class="sum-row"><span>${esc(l)}</span><b>${esc(v || '—')}</b></div>`;
  const ynv = o => !o ? '—' : (o.ok || '—') + (o.remarks ? ' · ' + o.remarks : '');
  const lvv = o => !o ? '—' : (o.level || '—') + (o.remarks ? ' · ' + o.remarks : '');
  const v = x.visit || {}, eq = x.equipment || {}, b = eq.before || {}, a = eq.after || {};
  const sys = x.system || {}, pw = x.power || {}, net = x.network || {}, rc = x.receiverConfig || {};
  const ftp = x.ftp || {}, dl = x.download || {}, ct = x.contact || {};
  const groupName = { sitePhotos: 'Site photo', simReplaced: 'SIM replacement', loadSufficient: 'Prepaid load' };
  return `
    <div class="card"><h3>A. Visit details</h3>
      ${row('Address', v.address)}${row('Date and time', (v.datetime || '').replace('T', ' '))}${row('Field party', (v.party || []).join(', '))}
    </div>
    <div class="card"><h3>B. Equipment</h3>
      <table class="eq"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>
        ${EQ_ROWS.map(([k, l]) => `<tr><td class="lbl">${l}</td><td>${esc(b[k] || '—')}</td><td>${esc(a[k] || '')}</td></tr>`).join('')}
      </tbody></table>
      ${row('Power failure', eq.powerFailure)}
    </div>
    ${(x.mismatches || []).length ? `<div class="card"><h3>Differences from SiteMetaData</h3>
      ${x.mismatches.map(m => `<div class="sum-row"><span>${esc(m.label)}</span><b class="warn">${esc(m.sitemetadata || '(blank)')} → ${esc(m.field_value || '(blank)')}</b></div>`).join('')}
    </div>` : ''}
    <div class="card"><h3>C. System check</h3>${SYSTEM_ITEMS.map(([k, l]) => row(l, ynv(sys[k]))).join('')}</div>
    <div class="card"><h3>D. Power source</h3>
      ${row('Battery', (pw.battery || '—') + (pw.batteryStatus ? ' · ' + pw.batteryStatus : ''))}
      ${row('Charger', ((pw.charger || []).join(', ') || '—') + (pw.chargerStatus ? ' · ' + pw.chargerStatus : ''))}
    </div>
    <div class="card"><h3>E. Network</h3>
      ${row('Router functional', ynv(net.router))}${row('SIM replacement done', ynv(net.simReplaced))}${row('Prepaid load sufficient', ynv(net.loadSufficient))}
    </div>
    <div class="card"><h3>F. Receiver configuration</h3>
      ${row('Unit logging', ynv(rc.logging))}${row('SD card storage', lvv(rc.sdCard))}${row('Navigated position', lvv(rc.navPosition))}
    </div>
    <div class="card"><h3>G. FTP push test</h3>${row('PHIVOLCS', ynv(ftp.phivolcs))}${row('NAMRIA', ynv(ftp.namria))}</div>
    <div class="card"><h3>H. Data downloading</h3>${row('Sessions', (dl.sessions || []).join(', '))}${SESSIONS.map(s => row(s + ' details', (dl.details || {})[s])).join('')}${row('Other / remarks', dl.other)}</div>
    <div class="card"><h3>I. Notes</h3><p style="white-space:pre-wrap;margin:0">${esc(x.notes || '—')}</p></div>
    <div class="card"><h3>J. Contact person</h3>
      ${row('Name', ct.person)}${row('Number', ct.number)}${row('Designation', ct.designation)}${row('Email', ct.email)}
    </div>
    <div class="card"><h3>K. Photos</h3>
      ${(x.photos || []).length ? `<div class="thumbs">${x.photos.map(p => `
        <a class="thumb" href="${esc(p.url)}" target="_blank" rel="noopener">
          <img src="https://drive.google.com/thumbnail?id=${esc(p.fileId)}&sz=w400" alt="" onerror="this.style.display='none'">
          <span class="up">${esc(groupName[p.group] || p.group)}</span>
        </a>`).join('')}</div>` : '<p class="muted" style="margin:0">No photos.</p>'}
    </div>
    <div class="card"><h3>L. Station status after visit</h3>${row('Status', x.stationStatusAfter)}</div>`;
}

function showReview(it) {
  if (!it) return showApprovals();
  S.screen = 'review';
  $app.innerHTML = `
    <button class="btn small ghost" id="back">← Approvals</button>
    <div class="card" style="margin-top:12px">
      <div class="between"><h2 style="margin:0">${esc(it.siteCode)}</h2><span class="pill">v${it.version}</span></div>
      <p class="muted" style="margin:6px 0 0">Submitted by ${esc(it.submittedBy)} on ${esc(it.submittedAt)}</p>
    </div>
    ${summaryHtml(it.data)}
    <div class="card">
      <h3>Decision</h3>
      <button class="btn" id="approve">Approve</button>
      <label>Comment for the team (required to return)</label>
      <textarea id="rcomment" rows="3" placeholder="What needs to be fixed?"></textarea>
      <button class="btn danger" id="return">Return for changes</button>
      <div class="msg" id="dmsg"></div>
    </div>`;
  document.getElementById('back').onclick = showApprovals;
  const dmsg = document.getElementById('dmsg');
  const busy = on => ['approve', 'return'].forEach(id => { document.getElementById(id).disabled = on; });

  document.getElementById('approve').onclick = async () => {
    if (!navigator.onLine) return alert('Approving needs signal.');
    if (!confirm('Approve ' + it.siteCode + ' v' + it.version + '? This creates the PDF.')) return;
    busy(true); dmsg.className = 'msg'; dmsg.textContent = 'Approving and creating the PDF... this can take up to a minute.';
    try {
      const r = await api('approveLogsheet', { id: it.id, version: it.version });
      dmsg.textContent = 'Approved. The PDF is being prepared and will appear for the team in about a minute.';
      S.approvals = S.approvals.filter(x => x.id !== it.id);
      document.getElementById('approve').textContent = 'Approved';
      refreshStatuses(); // archive updates now; PDF links follow when ready
    } catch (err) {
      dmsg.className = 'msg err'; dmsg.textContent = err.message; busy(false);
    }
  };

  document.getElementById('return').onclick = async () => {
    const comment = document.getElementById('rcomment').value.trim();
    if (!comment) { dmsg.className = 'msg err'; dmsg.textContent = 'Add a comment so the team knows what to fix.'; return; }
    if (!navigator.onLine) return alert('Returning needs signal.');
    if (!confirm('Return ' + it.siteCode + ' to the team?')) return;
    busy(true); dmsg.className = 'msg'; dmsg.textContent = 'Returning...';
    try {
      await api('returnLogsheet', { id: it.id, version: it.version, comment: comment });
      S.approvals = S.approvals.filter(x => x.id !== it.id);
      dmsg.textContent = 'Returned to the team.';
      document.getElementById('return').textContent = 'Returned';
    } catch (err) {
      dmsg.className = 'msg err'; dmsg.textContent = err.message; busy(false);
    }
  };
  window.scrollTo(0, 0);
}

/* ---------- Boot ---------- */
async function boot() {
  updateNet();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  S.session = await kvGet('session');
  S.stations = (await kvGet('stations')) || [];
  S.approvedAll = (await kvGet('approvedAll')) || [];
  S.stationsAt = await kvGet('stationsAt');
  if (!S.session) return showLogin();
  await showHome();
  refreshStations(true);
  syncAll(); // also refreshes statuses and approvals when done
}
boot();
