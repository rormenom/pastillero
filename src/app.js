import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, where, onSnapshot, setDoc, addDoc, updateDoc, deleteDoc,
  arrayUnion, deleteField, writeBatch
} from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App as CapApp } from '@capacitor/app';
import { firebaseConfig, VAPID_KEY } from './firebase-config.js';
import { H, MIN, keyOf, nextIntervalSlot as nextSlot, pending as pendingRaw, upcoming, shouldNotify } from './schedule.js';

const NATIVE = Capacitor.isNativePlatform();
const APP_BUILD = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 0;
const RELEASES_API = 'https://api.github.com/repos/rormenom/pastillero/releases/latest';
const COLORS = ['#E07A5F', '#3D8B7D', '#6C8EBF', '#C9A227', '#9C6ADE', '#D16BA5'];
const DAYS_AHEAD = 4;      // días de alarmas locales que se dejan programadas
const MAX_REPEATS = 8;     // repeticiones por toma si no se marca

// ---------- Firebase ----------
const fbApp = initializeApp(firebaseConfig);
const auth = initializeAuth(fbApp, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// ---------- estado ----------
let user = null, unsubs = [];
const S = { meds: [], log: [], settings: { remind: 30, snooze: 10, sound: 1 }, snoozes: {} };
let alerted = {};
try { alerted = JSON.parse(localStorage.getItem('pastillero.alerted') || '{}'); } catch (e) {}
const saveAlerted = () => { try { localStorage.setItem('pastillero.alerted', JSON.stringify(alerted)); } catch (e) {} };

const atLocal = (dayOffset, h, m) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };
const nextIntervalSlot = m => nextSlot(m, S.log);
const pending = () => pendingRaw(S.meds, S.log, Date.now(), atLocal);
const userRef = () => doc(db, 'users', user.uid);
const medsCol = () => collection(db, 'users', user.uid, 'meds');
const logCol = () => collection(db, 'users', user.uid, 'log');

// ---------- utilidades ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = t => new Date(t).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function rel(ms) { const m = Math.round(Math.abs(ms) / MIN); if (m < 1) return 'ahora'; if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + r + ' min' : ''); }
function dayLabel(t) { const d0 = startOfDay(), d = startOfDay(t); if (d === d0) return 'hoy'; if (d === d0 + 86400e3) return 'mañana'; if (d === d0 - 86400e3) return 'ayer'; return new Date(t).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'short' }); }
function toLocalInput(t) { const d = new Date(t); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2200); }
const pillSVG = c => `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(-35 12 12)"/><path d="M9.2 7.9l5.6 8.2"/></svg>`;
const tint = c => c + '22';
const isLogged = (id, slot) => S.log.find(l => l.medId === id && l.slot === slot);

// ---------- acciones sobre datos ----------
async function mark(medId, slot, status) {
  const k = keyOf(medId, slot);
  if (isLogged(medId, slot)) return;
  S.log.push({ medId, slot, at: Date.now(), status }); // optimista
  delete alerted[k]; delete S.snoozes[k]; saveAlerted();
  render(); refreshAlarm(); scheduleNative();
  try {
    await addDoc(logCol(), { medId, slot, at: Date.now(), status });
    await updateDoc(userRef(), { ['snoozes.' + k]: deleteField(), ['notified.' + k]: deleteField() });
  } catch (e) { console.warn(e); }
  if (NATIVE) clearDelivered(k);
}
async function snooze(k) {
  const until = Date.now() + S.settings.snooze * MIN;
  S.snoozes[k] = until; alerted[k] = Date.now(); saveAlerted();
  refreshAlarm(); scheduleNative();
  try { await updateDoc(userRef(), { ['snoozes.' + k]: until }); } catch (e) { console.warn(e); }
  if (NATIVE) clearDelivered(k);
  toast('Te aviso en ' + S.settings.snooze + ' min');
}
const saveSettings = () => updateDoc(userRef(), { settings: S.settings }).catch(console.warn);

// ---------- suscripción a Firestore ----------
function subscribe() {
  unsubs.forEach(u => u()); unsubs = [];
  unsubs.push(onSnapshot(userRef(), snap => {
    const d = snap.data() || {};
    S.settings = Object.assign({ remind: 30, snooze: 10, sound: 1 }, d.settings || {});
    S.snoozes = d.snoozes || {};
    syncSettings(); refreshAlarm(); scheduleNative();
  }));
  unsubs.push(onSnapshot(medsCol(), snap => {
    S.meds = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.created || 0) - (b.created || 0));
    render(); tick(); scheduleNative();
  }));
  const since = Date.now() - 60 * 86400e3;
  unsubs.push(onSnapshot(query(logCol(), where('at', '>', since)), snap => {
    S.log = snap.docs.map(d => Object.assign({ _id: d.id }, d.data()));
    render(); refreshAlarm(); scheduleNative();
  }));
}

// ---------- auth ----------
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('authTitle').textContent = m === 'signup' ? 'Crear cuenta' : m === 'reset' ? 'Recuperar' : 'Pastillero';
  $('authLead').textContent = m === 'signup' ? 'Con tu cuenta, tus medicamentos quedan respaldados y sincronizados.' : m === 'reset' ? 'Te enviaremos un correo para crear una nueva contraseña.' : 'Entra para tener tus medicamentos en todos tus dispositivos.';
  $('aSubmit').textContent = m === 'signup' ? 'Crear cuenta' : m === 'reset' ? 'Enviar correo' : 'Entrar';
  $('passBox').style.display = m === 'reset' ? 'none' : '';
  $('aToggle').textContent = m === 'login' ? 'Crear cuenta' : 'Ya tengo cuenta';
  $('aForgot').style.display = m === 'login' ? '' : 'none';
  $('aPass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('aErr').textContent = '';
}
const AUTH_ERR = {
  'auth/invalid-credential': 'Email o contraseña incorrectos.', 'auth/wrong-password': 'Contraseña incorrecta.',
  'auth/user-not-found': 'No existe una cuenta con ese email.', 'auth/email-already-in-use': 'Ya existe una cuenta con ese email.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.', 'auth/invalid-email': 'El email no es válido.',
  'auth/network-request-failed': 'Sin conexión. Revisa tu internet.', 'auth/too-many-requests': 'Demasiados intentos. Espera un momento.'
};
$('aToggle').onclick = () => setAuthMode(authMode === 'login' ? 'signup' : 'login');
$('aForgot').onclick = () => setAuthMode('reset');
$('authForm').onsubmit = async e => {
  e.preventDefault(); $('aErr').textContent = ''; $('aSubmit').disabled = true;
  const email = $('aEmail').value.trim(), pass = $('aPass').value;
  try {
    if (authMode === 'reset') { await sendPasswordResetEmail(auth, email); toast('Correo enviado'); setAuthMode('login'); }
    else if (authMode === 'signup') await createUserWithEmailAndPassword(auth, email, pass);
    else await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) { $('aErr').textContent = AUTH_ERR[err.code] || 'No se pudo completar (' + (err.code || err.message) + ').'; }
  $('aSubmit').disabled = false;
};
$('btnLogout').onclick = () => confirmBox('¿Cerrar sesión?', 'Salir', async () => {
  if (NATIVE) await cancelAllNative();
  await signOut(auth);
});

onAuthStateChanged(auth, async u => {
  $('boot').style.display = 'none';
  user = u;
  if (!u) {
    unsubs.forEach(x => x()); unsubs = []; S.meds = []; S.log = [];
    document.body.classList.add('out'); $('authView').style.display = ''; $('appView').style.display = 'none';
    setAuthMode('login'); return;
  }
  document.body.classList.remove('out'); $('authView').style.display = 'none'; $('appView').style.display = '';
  $('accEmail').textContent = u.email;
  try { await setDoc(userRef(), { email: u.email, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, { merge: true }); } catch (e) {}
  subscribe();
  if (NATIVE) await setupNative(); else setupWebPush(false);
  flushPendingActions();
});

// ---------- render ----------
function todayItems() {
  const now = Date.now(), d0 = startOfDay(), d1 = d0 + 86400e3, items = [];
  for (const m of S.meds) {
    if (m.mode === 'fixed') {
      for (const t of (m.times || [])) {
        const [h, mi] = t.split(':').map(Number); const s = atLocal(0, h, mi); const l = isLogged(m.id, s);
        const st = l ? l.status : (m.paused ? 'paused' : (s < (m.created || 0) - MIN ? 'none' : (s <= now ? 'late' : 'up')));
        items.push({ med: m, slot: s, status: st, at: l && l.at });
      }
    } else {
      S.log.filter(l => l.medId === m.id && l.slot >= d0 && l.slot < d1).forEach(l => items.push({ med: m, slot: l.slot, status: l.status, at: l.at }));
      const s = nextIntervalSlot(m);
      if (!m.paused) items.push({ med: m, slot: s, status: s <= now ? 'late' : 'up' });
    }
  }
  return items.filter(i => i.status !== 'none').sort((a, b) => a.slot - b.slot);
}
function render() {
  if (!user) return;
  const h = new Date().getHours();
  $('hello').textContent = (h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches') + ' · ' + new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  renderToday(); renderMeds(); renderHist(); renderNotifState();
}
function renderToday() {
  const items = todayItems(), now = Date.now(), nb = $('nextBox');
  if (!S.meds.length) {
    nb.innerHTML = ''; $('progress').textContent = '';
    $('todayList').innerHTML = `<div class="empty"><b>Aún no hay medicamentos</b>Toca el botón <span style="color:var(--coral);font-weight:600">+</span> para agregar el primero.</div>`; return;
  }
  const late = items.filter(i => i.status === 'late');
  const up = items.filter(i => i.status === 'up')[0];
  if (late.length) {
    nb.innerHTML = `<div class="next" style="background:var(--coral)"><div class="lbl">Pendiente</div><div class="name">${esc(late[0].med.name)}</div><div class="when">Tocaba a las ${hm(late[0].slot)} · hace ${rel(now - late[0].slot)}</div>
      <button class="btn sm" style="margin-top:14px;background:#fff;color:#B4512F" data-take="${late[0].med.id}|${late[0].slot}">Marcar como tomado</button></div>`;
  } else if (up) {
    nb.innerHTML = `<div class="next"><div class="lbl">Próxima toma</div><div class="name">${esc(up.med.name)}</div><div class="when">${up.med.dose ? esc(up.med.dose) + ' · ' : ''}${dayLabel(up.slot)} en ${rel(up.slot - now)}</div><div class="big">${hm(up.slot)}</div></div>`;
  } else nb.innerHTML = `<div class="next"><div class="lbl">Todo al día</div><div class="name">No quedan tomas hoy</div><div class="when">Buen trabajo 🌿</div></div>`;
  const done = items.filter(i => i.status === 'taken').length, tot = items.filter(i => i.status !== 'paused').length;
  $('progress').textContent = tot ? `${done} de ${tot}` : '';
  $('todayList').innerHTML = items.map(i => {
    const st = { taken: ['p-ok', 'Tomado ' + hm(i.at)], skipped: ['p-skip', 'Omitido'], late: ['p-late', 'Atrasado'], up: ['p-up', dayLabel(i.slot) === 'hoy' ? 'Pendiente' : dayLabel(i.slot)], paused: ['p-skip', 'En pausa'] }[i.status];
    const act = i.status === 'late' || (i.status === 'up' && i.slot - now < 2 * H) ? `<button class="btn sm" data-take="${i.med.id}|${i.slot}">Tomé</button>` : '';
    return `<div class="item ${i.status === 'taken' || i.status === 'skipped' ? 'taken' : ''}">
      <div class="dot" style="background:${tint(i.med.color)}">${pillSVG(i.med.color)}</div>
      <div class="meta"><div class="t">${esc(i.med.name)}</div><div class="s">${esc(i.med.dose || '')}${i.med.dose && i.med.note ? ' · ' : ''}${esc(i.med.note || '')}</div>
      <div style="margin-top:6px"><span class="pill ${st[0]}">${st[1]}</span></div></div>
      ${act}<div class="time">${hm(i.slot)}</div></div>`;
  }).join('') || `<div class="empty">Sin tomas programadas hoy.</div>`;
}
function renderMeds() {
  $('medCount').textContent = S.meds.length ? S.meds.length + (S.meds.length === 1 ? ' medicamento' : ' medicamentos') : '';
  $('medList').innerHTML = S.meds.map(m => {
    const n = m.mode === 'interval' ? nextIntervalSlot(m) : 0;
    const plan = m.mode === 'fixed' ? 'A las ' + (m.times || []).join(', ') : 'Cada ' + m.interval + ' h · próxima ' + dayLabel(n) + ' ' + hm(n);
    return `<div class="item" style="${m.paused ? 'opacity:.6' : ''}">
      <div class="dot" style="background:${tint(m.color)}">${pillSVG(m.color)}</div>
      <div class="meta"><div class="t">${esc(m.name)}${m.paused ? ' · <span class="pill p-skip">En pausa</span>' : ''}</div><div class="s">${esc(m.dose || '')}${m.dose ? ' · ' : ''}${plan}</div></div>
      <button class="icon-btn" data-pause="${m.id}" title="${m.paused ? 'Reanudar' : 'Pausar'}">${m.paused ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'}</button>
      <button class="icon-btn" data-edit="${m.id}" title="Editar"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button></div>`;
  }).join('') || `<div class="empty"><b>Tu pastillero está vacío</b>Agrega tus medicamentos con el botón +.</div>`;
}
function renderHist() {
  const lim = Date.now() - 14 * 86400e3, ls = S.log.filter(l => l.at > lim).sort((a, b) => b.slot - a.slot);
  if (!ls.length) { $('histList').innerHTML = `<div class="empty">Aquí verás las tomas que marques.</div>`; return; }
  let html = '', cur = '';
  for (const l of ls) {
    const m = S.meds.find(x => x.id === l.medId) || { name: '(eliminado)', color: '#999999' };
    const dl = dayLabel(l.slot); if (dl !== cur) { cur = dl; html += `<div class="day-h">${dl}</div>`; }
    const late = l.status === 'taken' ? Math.round((l.at - l.slot) / MIN) : 0;
    html += `<div class="item" style="margin-bottom:8px"><div class="dot" style="background:${tint(m.color)}">${pillSVG(m.color)}</div>
      <div class="meta"><div class="t">${esc(m.name)}</div><div class="s">Programada ${hm(l.slot)}${l.status === 'taken' ? ' · tomada ' + hm(l.at) + (late > 15 ? ' (' + rel(late * MIN) + ' tarde)' : '') : ''}</div></div>
      <span class="pill ${l.status === 'taken' ? 'p-ok' : 'p-skip'}">${l.status === 'taken' ? 'Tomado' : 'Omitido'}</span></div>`;
  }
  $('histList').innerHTML = html;
}

// ---------- navegación ----------
const titles = { hoy: 'Hoy', meds: 'Medicamentos', hist: 'Historial', set: 'Ajustes' };
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + b.dataset.v));
  $('title').textContent = titles[b.dataset.v]; $('fab').style.display = b.dataset.v === 'set' ? 'none' : 'grid';
  window.scrollTo(0, 0); render();
});

// ---------- formulario ----------
let editing = null, fColor = COLORS[0], fMode = 'interval', fTimes = ['08:00'];
function drawColors() { $('fColors').innerHTML = COLORS.map(c => `<button type="button" style="background:${c}" class="${c === fColor ? 'on' : ''}" data-c="${c}"></button>`).join(''); }
function drawTimes() { $('fTimes').innerHTML = fTimes.map((t, i) => `<div class="row"><input type="time" value="${t}" data-ti="${i}">${fTimes.length > 1 ? `<button class="btn sm ghost" data-rm="${i}">✕</button>` : ''}</div>`).join(''); }
function setMode(m) { fMode = m; document.querySelectorAll('#fMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); $('boxInterval').style.display = m === 'interval' ? '' : 'none'; $('boxFixed').style.display = m === 'fixed' ? '' : 'none'; }
function openForm(med) {
  editing = med || null;
  $('formTitle').textContent = med ? 'Editar medicamento' : 'Nuevo medicamento';
  $('fName').value = med ? med.name : ''; $('fDose').value = med ? med.dose || '' : ''; $('fNote').value = med ? med.note || '' : '';
  fColor = med ? med.color : COLORS[S.meds.length % COLORS.length];
  $('fInterval').value = med && med.interval ? med.interval : 8;
  $('fStart').value = toLocalInput(med && med.mode === 'interval' ? nextIntervalSlot(med) : Date.now());
  fTimes = med && med.times && med.times.length ? [...med.times] : ['08:00', '20:00'];
  setMode(med ? med.mode : 'interval'); drawColors(); drawTimes();
  $('fDelete').style.display = med ? '' : 'none';
  $('formScrim').classList.add('on');
}
const closeForm = () => $('formScrim').classList.remove('on');
$('fab').onclick = () => openForm();
$('fCancel').onclick = closeForm;
$('formScrim').onclick = e => { if (e.target.id === 'formScrim') closeForm(); };
$('fColors').onclick = e => { if (e.target.dataset.c) { fColor = e.target.dataset.c; drawColors(); } };
$('fMode').onclick = e => { if (e.target.dataset.m) setMode(e.target.dataset.m); };
$('fAddTime').onclick = () => { fTimes.push('14:00'); drawTimes(); };
$('fTimes').oninput = e => { if (e.target.dataset.ti != null) fTimes[+e.target.dataset.ti] = e.target.value; };
$('fTimes').onclick = e => { if (e.target.dataset.rm != null) { fTimes.splice(+e.target.dataset.rm, 1); drawTimes(); } };
$('fSave').onclick = async () => {
  const name = $('fName').value.trim(); if (!name) { $('fName').focus(); toast('Escribe el nombre'); return; }
  const data = { name, dose: $('fDose').value.trim(), note: $('fNote').value.trim(), color: fColor, mode: fMode };
  if (fMode === 'interval') {
    data.interval = Math.max(1, parseFloat($('fInterval').value) || 8);
    data.start = new Date($('fStart').value).getTime() || Date.now();
    data.times = [];
  } else {
    const ts = [...new Set(fTimes.filter(Boolean))].sort(); if (!ts.length) { toast('Agrega al menos un horario'); return; }
    data.times = ts;
  }
  const wasEditing = !!editing;
  closeForm();
  try {
    if (editing) {
      const restart = fMode === 'interval' && (editing.mode !== 'interval' || Math.abs(data.start - nextIntervalSlot(editing)) > MIN);
      if (restart) { // nueva primera toma: el conteo se reinicia desde ahí
        const b = writeBatch(db);
        S.log.filter(l => l.medId === editing.id && !l.archived && l._id).forEach(l => b.update(doc(logCol(), l._id), { archived: true }));
        await b.commit();
      }
      await updateDoc(doc(medsCol(), editing.id), data);
    } else {
      await addDoc(medsCol(), Object.assign({ created: Date.now(), paused: false }, data));
    }
    toast(wasEditing ? 'Cambios guardados' : 'Medicamento agregado');
  } catch (e) { toast('No se pudo guardar'); console.warn(e); }
};
let confAction = null;
function confirmBox(text, yes, fn) { $('confText').textContent = text; $('confYes').textContent = yes; confAction = fn; $('confScrim').classList.add('on'); }
$('confNo').onclick = () => $('confScrim').classList.remove('on');
$('confYes').onclick = () => { $('confScrim').classList.remove('on'); confAction && confAction(); };
$('fDelete').onclick = () => {
  const m = editing; closeForm();
  confirmBox(`¿Eliminar ${m.name}?`, 'Eliminar', async () => { await deleteDoc(doc(medsCol(), m.id)); toast('Eliminado'); });
};
document.body.addEventListener('click', e => {
  const t = e.target.closest('[data-take],[data-edit],[data-pause]'); if (!t) return;
  if (t.dataset.take) { const [id, s] = t.dataset.take.split('|'); mark(id, +s, 'taken'); toast('¡Registrado! ✓'); }
  if (t.dataset.edit) openForm(S.meds.find(m => m.id === t.dataset.edit));
  if (t.dataset.pause) {
    const m = S.meds.find(x => x.id === t.dataset.pause);
    updateDoc(doc(medsCol(), m.id), { paused: !m.paused }); toast(m.paused ? 'Reanudado' : 'En pausa');
  }
});

// ---------- alarma dentro de la app ----------
let audioCtx = null;
function unlockAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {} }
document.addEventListener('pointerdown', unlockAudio, { passive: true });
function chime() {
  if (NATIVE || !+S.settings.sound || !audioCtx) return;
  try {
    const notes = [659.25, 783.99, 1046.5], t0 = audioCtx.currentTime;
    for (let r = 0; r < 2; r++) notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = f;
      const st = t0 + r * 1.1 + i * .18; g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(.25, st + .02); g.gain.exponentialRampToValueAtTime(.001, st + .9);
      o.connect(g).connect(audioCtx.destination); o.start(st); o.stop(st + 1);
    });
  } catch (e) {}
}
const visiblePending = () => { const now = Date.now(); return pending().filter(p => !(S.snoozes[keyOf(p.med.id, p.slot)] > now)); };
function refreshAlarm() {
  const list = visiblePending();
  if (!list.length) { $('alarm').classList.remove('on'); return; }
  if ($('alarm').classList.contains('on')) drawAlarm(list);
}
function drawAlarm(list) {
  $('alarmSub').textContent = list.length === 1 ? 'Tienes 1 toma pendiente' : 'Tienes ' + list.length + ' tomas pendientes';
  $('alarmDoses').innerHTML = list.map(p => {
    const k = keyOf(p.med.id, p.slot);
    return `<div class="dose"><div class="n">${esc(p.med.name)}</div>
    <div class="d">${p.med.dose ? esc(p.med.dose) + ' · ' : ''}tocaba a las ${hm(p.slot)}${Date.now() - p.slot > 5 * MIN ? ' (hace ' + rel(Date.now() - p.slot) + ')' : ''}${p.med.note ? ' · ' + esc(p.med.note) : ''}</div>
    <div class="b"><button class="btn light" data-a="take" data-k="${k}">Tomado</button><button class="btn clear" data-a="snooze" data-k="${k}">+${S.settings.snooze} min</button><button class="btn clear" data-a="skip" data-k="${k}">Omitir</button></div></div>`;
  }).join('');
}
function showAlarm(list) { drawAlarm(list); $('alarm').classList.add('on'); chime(); try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch (e) {} }
$('alarmDoses').onclick = e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  if (b.dataset.test) { $('alarm').classList.remove('on'); return; }
  const k = b.dataset.k, i = k.lastIndexOf('_'), id = k.slice(0, i), s = +k.slice(i + 1);
  if (b.dataset.a === 'take') { mark(id, s, 'taken'); toast('¡Registrado! ✓'); }
  if (b.dataset.a === 'skip') { mark(id, s, 'skipped'); toast('Toma omitida'); }
  if (b.dataset.a === 'snooze') snooze(k);
};
function tick() {
  if (!user) return;
  const now = Date.now(), fire = [];
  for (const p of pending()) {
    const k = keyOf(p.med.id, p.slot);
    if (shouldNotify(k, now, alerted[k], S.snoozes[k], S.settings.remind)) fire.push(p);
  }
  if (fire.length) { fire.forEach(p => alerted[keyOf(p.med.id, p.slot)] = now); saveAlerted(); const v = visiblePending(); if (v.length) showAlarm(v); }
  renderToday();
}

// ---------- Android: alarmas locales ----------
let schedTimer = null, nativeReady = false;
const pendingActions = [];
function scheduleNative() { if (!NATIVE || !nativeReady) return; clearTimeout(schedTimer); schedTimer = setTimeout(rescheduleNative, 600); }
async function cancelAllNative() {
  try { const p = await LocalNotifications.getPending(); if (p.notifications.length) await LocalNotifications.cancel({ notifications: p.notifications.map(n => ({ id: n.id })) }); } catch (e) {}
}
async function clearDelivered(k) {
  try { const d = await LocalNotifications.getDeliveredNotifications(); const mine = d.notifications.filter(n => n.extra && n.extra.k === k); if (mine.length) await LocalNotifications.removeDeliveredNotifications({ notifications: mine }); } catch (e) {}
}
async function rescheduleNative() {
  if (!user) return;
  await cancelAllNative();
  const now = Date.now(), list = upcoming(S.meds, S.log, now, atLocal, DAYS_AHEAD), out = [];
  let id = 1;
  for (const p of list) {
    const k = keyOf(p.med.id, p.slot), sn = S.snoozes[k];
    const first = sn && sn > p.slot ? sn : p.slot;
    for (let r = 0; r < MAX_REPEATS; r++) {
      const at = first + r * S.settings.remind * MIN;
      if (at <= now + 5000) continue;
      out.push({
        id: id++, channelId: 'meds', actionTypeId: 'DOSE',
        title: r === 0 ? 'Hora de tu medicamento' : 'Recordatorio: aún no marcas tu toma',
        body: p.med.name + (p.med.dose ? ' · ' + p.med.dose : '') + ' — ' + hm(p.slot),
        schedule: { at: new Date(at), allowWhileIdle: true },
        extra: { k, medId: p.med.id, slot: p.slot }, autoCancel: true, smallIcon: 'ic_stat_pill', iconColor: '#1F4E4A'
      });
    }
    if (id > 400) break; // límite prudente de alarmas programadas
  }
  if (out.length) { try { await LocalNotifications.schedule({ notifications: out }); } catch (e) { console.warn('schedule', e); } }
}
function handleAction(a) {
  if (!user) { pendingActions.push(a); return; }
  const x = a.notification.extra || {};
  if (!x.k) return;
  if (a.actionId === 'take') { mark(x.medId, +x.slot, 'taken'); toast('¡Registrado! ✓'); }
  else if (a.actionId === 'snooze') snooze(x.k);
  else setTimeout(tick, 800); // tocar la notificación abre la app y muestra la alarma
}
function flushPendingActions() { while (pendingActions.length) handleAction(pendingActions.shift()); }
if (NATIVE) {
  // el listener se registra al cargar para no perder la acción que abrió la app
  LocalNotifications.addListener('localNotificationActionPerformed', handleAction);
  CapApp.addListener('resume', () => { tick(); scheduleNative(); renderNotifState(); });
}
async function setupNative() {
  try {
    await LocalNotifications.createChannel({ id: 'meds', name: 'Medicamentos', description: 'Avisos para tomar tus medicamentos', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#E07A5F' });
    await LocalNotifications.registerActionTypes({ types: [{ id: 'DOSE', actions: [{ id: 'take', title: 'Tomado ✓' }, { id: 'snooze', title: 'Posponer' }] }] });
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') await LocalNotifications.requestPermissions();
  } catch (e) { console.warn(e); }
  nativeReady = true; scheduleNative(); renderNotifState();
}

// ---------- Web: push con Firebase Cloud Messaging ----------
async function setupWebPush(ask) {
  if (NATIVE || !('serviceWorker' in navigator) || !('Notification' in window)) return false;
  try {
    if (ask && Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted' || !VAPID_KEY || VAPID_KEY.startsWith('PEGAR')) return false;
    const { getMessaging, getToken, isSupported } = await import('firebase/messaging');
    if (!(await isSupported())) return false;
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    const token = await getToken(getMessaging(fbApp), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) await setDoc(userRef(), { fcmTokens: arrayUnion(token), pushEnabled: true }, { merge: true });
    return !!token;
  } catch (e) { console.warn('push', e); return false; }
}

// ---------- ajustes ----------
[5, 10, 15, 20, 30, 45, 60, 90, 120].forEach(m => $('setRemind').insertAdjacentHTML('beforeend', `<option value="${m}">${m < 60 ? m + ' min' : m / 60 + ' h'}</option>`));
[5, 10, 15, 30, 60].forEach(m => $('setSnooze').insertAdjacentHTML('beforeend', `<option value="${m}">${m < 60 ? m + ' min' : '1 h'}</option>`));
function syncSettings() { $('setRemind').value = S.settings.remind; $('setSnooze').value = S.settings.snooze; $('setSound').value = S.settings.sound; }
$('setRemind').onchange = e => { S.settings.remind = +e.target.value; saveSettings(); scheduleNative(); toast('Repetiré el aviso cada ' + e.target.selectedOptions[0].text); };
$('setSnooze').onchange = e => { S.settings.snooze = +e.target.value; saveSettings(); };
$('setSound').onchange = e => { S.settings.sound = +e.target.value; saveSettings(); };
async function renderNotifState() {
  if (NATIVE) {
    $('rowSound').style.display = 'none'; $('rowExact').style.display = '';
    $('platformHint').textContent = 'Los avisos se programan en el teléfono y suenan aunque la app esté cerrada o no haya internet. Si usas ahorro de batería, excluye esta app para que no se atrasen.';
    try {
      const p = await LocalNotifications.checkPermissions();
      $('notifState').textContent = p.display === 'granted' ? 'Activadas' : 'Sin permiso';
      $('btnNotif').style.display = p.display === 'granted' ? 'none' : '';
      const ex = await LocalNotifications.checkExactNotificationSetting();
      $('exactState').textContent = ex.exact_alarm === 'granted' ? 'Permitidas' : 'Sin permiso: los avisos podrían atrasarse';
      $('btnExact').style.display = ex.exact_alarm === 'granted' ? 'none' : '';
      $('notifBanner').innerHTML = p.display !== 'granted' ? `<div class="banner"><span>Activa las notificaciones para recibir los avisos.</span><button class="btn sm" onclick="document.getElementById('btnNotif').click()">Activar</button></div>` : '';
    } catch (e) {}
    return;
  }
  let st = 'No disponibles en este navegador';
  try { if ('Notification' in window) st = { granted: 'Activadas', denied: 'Bloqueadas en el navegador', default: 'Sin activar' }[Notification.permission]; } catch (e) {}
  $('notifState').textContent = st;
  $('platformHint').textContent = 'En la web, con notificaciones activadas, recibirás avisos aunque cierres la página. Para máxima confiabilidad usa la app Android.';
}
$('btnNotif').onclick = async () => {
  unlockAudio();
  if (NATIVE) { await LocalNotifications.requestPermissions(); scheduleNative(); }
  else toast((await setupWebPush(true)) ? 'Notificaciones activadas' : 'No se pudieron activar');
  renderNotifState();
};
$('btnExact').onclick = async () => { try { await LocalNotifications.changeExactNotificationSetting(); } catch (e) {} renderNotifState(); };
$('btnTest').onclick = async () => {
  unlockAudio();
  if (NATIVE) {
    await LocalNotifications.schedule({ notifications: [{ id: 9999, channelId: 'meds', title: 'Prueba de aviso', body: 'Así te llegarán los recordatorios', schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true } }] });
    toast('Llegará en 5 segundos');
    return;
  }
  $('alarmSub').textContent = 'Así se verá el aviso';
  $('alarmDoses').innerHTML = `<div class="dose"><div class="n">Prueba de alarma</div><div class="d">Toca cualquier botón para cerrar</div><div class="b"><button class="btn light" data-a="x" data-test="1">Tomado</button><button class="btn clear" data-a="x" data-test="1">+10 min</button><button class="btn clear" data-a="x" data-test="1">Omitir</button></div></div>`;
  $('alarm').classList.add('on'); chime();
};


// ---------- actualizaciones (solo Android) ----------
let update = null;
async function checkUpdate(manual) {
  if (!NATIVE) return;
  try {
    const last = +localStorage.getItem('pastillero.updCheck') || 0;
    if (!manual && Date.now() - last < 6 * H && localStorage.getItem('pastillero.upd')) {
      update = JSON.parse(localStorage.getItem('pastillero.upd'));
    } else {
      const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const build = +((j.tag_name || '').split('.').pop()) || 0;
      const asset = (j.assets || []).find(x => x.name.endsWith('.apk'));
      update = asset ? { build, name: j.tag_name.replace(/^v/, ''), url: asset.browser_download_url } : null;
      localStorage.setItem('pastillero.updCheck', String(Date.now()));
      localStorage.setItem('pastillero.upd', JSON.stringify(update));
    }
  } catch (e) { if (manual) toast('No se pudo revisar (¿sin internet?)'); }
  renderUpdate();
  if (manual && update && update.build <= APP_BUILD) toast('Tienes la última versión');
}
function renderUpdate() {
  if (!NATIVE) return;
  $('secVersion').style.display = ''; $('cardVersion').style.display = '';
  $('verLabel').textContent = 'Versión 1.0.' + APP_BUILD;
  const has = update && update.build > APP_BUILD;
  $('verState').textContent = has ? 'Disponible: ' + update.name : 'Al día';
  $('btnUpd').textContent = has ? 'Actualizar' : 'Buscar';
  $('updBanner').innerHTML = has ? `<div class="banner" style="background:#E8F2EF;border-color:#BFDCD4;color:var(--teal)"><span><b>Nueva versión ${esc(update.name)}</b><br>Toca para descargar e instalar.</span><button class="btn sm" data-upd="1">Actualizar</button></div>` : '';
}
function openUpdate() {
  if (!update) return;
  toast('Descargando… abre el archivo para instalar');
  window.location.href = update.url; // Android lo abre en el navegador y descarga el APK
}
$('btnUpd').onclick = () => (update && update.build > APP_BUILD) ? openUpdate() : checkUpdate(true);
document.body.addEventListener('click', e => { if (e.target.closest('[data-upd]')) openUpdate(); });
if (NATIVE) { checkUpdate(false); CapApp.addListener('resume', () => checkUpdate(false)); }

// ---------- inicio ----------
setInterval(tick, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
