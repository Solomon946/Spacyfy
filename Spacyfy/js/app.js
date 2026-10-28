'use strict';
const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s), esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = s => isFinite(s) && s > 0 ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00';
/* ---------- IndexedDB (v2 adds a lyrics store) ---------- */
const db = new Promise((ok, no) => { const r = indexedDB.open('wavelength', 2); r.onupgradeneeded = () => ['tracks', 'lists', 'lyrics'].forEach(n => r.result.objectStoreNames.contains(n) || r.result.createObjectStore(n, { keyPath: 'id' })); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) });
const req = (st, mode, fn) => db.then(d => new Promise((ok, no) => { const t = d.transaction(st, mode), r = fn(t.objectStore(st)); t.oncomplete = () => ok(r && r.result); t.onerror = t.onabort = () => no(t.error) }));
const put = (st, v) => req(st, 'readwrite', s => s.put(v)), del = (st, k) => req(st, 'readwrite', s => s.delete(k)), all = st => req(st, 'readonly', s => s.getAll());
/* ---------- state ---------- */
// repeat: 0 = off, 1 = loop this track (until you turn it off), 2 = loop whole queue
let tracks = [], lists = [], view = 'home', q = '', queue = [], qi = -1, shown = [], sort = 'added', shuffle = false, repeat = 0, tok = 0, url = null, lastId = null, sk = false, L = null, li = -1, lyId = null;
const S = JSON.parse(localStorage.wl || '{}'), stats = JSON.parse(localStorage.wlst || '{}');
const save = () => localStorage.wl = JSON.stringify(S), saveStat = t => { stats[t.id] = { p: t.plays, l: t.last, f: t.fav }; localStorage.wlst = JSON.stringify(stats) };
const SORT = { added: (x, y) => y.added - x.added, title: (x, y) => x.title.localeCompare(y.title), artist: (x, y) => x.artist.localeCompare(y.artist), dur: (x, y) => y.dur - x.dur };
const au = new Audio(); au.preload = 'auto';
const fs = $('#fs'), LY = $('#ly'), cur = () => tracks.find(t => t.id === queue[qi]), buzz = () => navigator.vibrate && navigator.vibrate(12);
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2600) }
/* ---------- artwork ---------- */
const ac = new Map(), art = t => { if (!t || !t.art) return ''; if (!ac.has(t.id)) ac.set(t.id, URL.createObjectURL(t.art)); return ac.get(t.id) };
const cover = t => art(t) ? `<img src="${art(t)}" alt="" loading="lazy">` : '<div class="ph">♪</div>';
function glow(t) { const u = art(t), g = $('#glow'); if (!u) { g.style.removeProperty('--g'); return } const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.drawImage(i, 0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; g.style.setProperty('--g', `${d[0]},${d[1]},${d[2]}`); document.body.style.setProperty('--g', `${d[0]},${d[1]},${d[2]}`) }; i.src = u }
/* ---------- ID3v2 (2.3/2.4): title, artist, album, cover ---------- */
async function tags(f) {
  const o = {}; try {
    const u = new Uint8Array(await f.slice(0, 4 << 20).arrayBuffer()), b = new DataView(u.buffer);
    if (String.fromCharCode(u[0], u[1], u[2]) !== 'ID3') return o;
    const v = u[3], ss = i => (u[i] << 21) | (u[i + 1] << 14) | (u[i + 2] << 7) | u[i + 3], end = Math.min(ss(6) + 10, u.length); let p = 10;
    const dec = (a, e) => new TextDecoder(e === 1 ? 'utf-16' : e === 3 ? 'utf-8' : 'iso-8859-1').decode(a).replace(/\0/g, '').trim();
    while (p + 10 < end) {
      const id = String.fromCharCode(...u.slice(p, p + 4)); if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const n = v === 4 ? ss(p + 4) : b.getUint32(p + 4), d = u.slice(p + 10, p + 10 + n); p += 10 + n;
      if (id === 'TIT2') o.title = dec(d.slice(1), d[0]); else if (id === 'TPE1') o.artist = dec(d.slice(1), d[0]); else if (id === 'TALB') o.album = dec(d.slice(1), d[0]);
      else if (id === 'APIC' && !o.art) {
        let i = 1; while (d[i]) i++; const mime = dec(d.slice(1, i), 0); i += 2;
        if (d[0] === 1 || d[0] === 2) { while (!(d[i] === 0 && d[i + 1] === 0)) i += 2; i += 2 } else { while (d[i]) i++; i++ }
        if (i < d.length) o.art = new Blob([d.slice(i)], { type: /^image\//.test(mime) ? mime : 'image/jpeg' })
      }
    }
  } catch { } return o
}
const dur = blob => new Promise(ok => { const a = new Audio(), u = URL.createObjectURL(blob), f = n => { ok(n); URL.revokeObjectURL(u) }; a.preload = 'metadata'; a.onloadedmetadata = () => f(a.duration || 0); a.onerror = () => f(0); a.src = u });
/* ---------- import ---------- */
async function imp(files) {
  let n = 0, s = 0; $('#bar').classList.add('busy');
  for (const f of files) {
    if (!/^audio\//.test(f.type) && !/\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i.test(f.name) || tracks.some(t => t.name === f.name && t.size === f.size)) { s++; continue }
    const m = await tags(f), t = { id: crypto.randomUUID(), title: m.title || f.name.replace(/\.[^.]+$/, ''), artist: m.artist || 'Unknown artist', album: m.album || 'Unknown album', dur: await dur(f), added: Date.now(), plays: 0, last: 0, fav: 0, blob: f, art: m.art || null, size: f.size, name: f.name };
    try { await put('tracks', t); tracks.push(t); n++ } catch (e) { toast(e && e.name === 'QuotaExceededError' ? 'Storage is full. Remove some tracks and try again.' : 'Could not save ' + f.name) }
  }
  $('#bar').classList.remove('busy'); navigator.storage?.persist?.();
  toast(`Imported ${n} track${n === 1 ? '' : 's'}` + (s ? `; skipped ${s} duplicate or unsupported` : '')); render(); usage()
}
/* ---------- playback ---------- */
async function play(i) {
  if (i < 0 || i >= queue.length) return; qi = i; const t = cur(); if (!t) return; const my = ++tok;
  if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(t.blob); au.src = url; au.loop = repeat === 1; au.playbackRate = +($('#spd').value); ui();
  try { await au.play() } catch (e) { if (my === tok && e.name !== 'AbortError') toast(`Can't play "${t.title}". Your browser may not support this format.`) }
  if (my === tok && !au.paused) { t.plays++; t.last = Date.now(); saveStat(t) }
}
/* Loop one stays on until you press the loop button again. Next/Previous move to another track and keep looping it.
   With any loop mode on, Next at the end of the queue wraps to the start. */
function step(d, auto) {
  if (!queue.length) return;
  if (auto && repeat === 1) { au.currentTime = 0; au.play(); return }
  let i; if (shuffle && queue.length > 1) { do i = Math.floor(Math.random() * queue.length); while (i === qi) } else i = qi + d;
  if (i >= queue.length) { if (repeat) i = 0; else { if (auto) au.pause(); return } }
  if (i < 0) i = repeat ? queue.length - 1 : 0; play(i)
}
function upNext() { const n = tracks.find(x => x.id === queue[qi + 1]); $('#up').textContent = repeat === 1 ? 'Looping this track' : n ? 'Up next: ' + n.title : repeat === 2 ? 'Looping the queue' : 'End of queue' }
function ui() {
  const t = cur(), p = !au.paused;
  $('#tt').textContent = t ? t.title : 'Nothing playing'; $('#ta').textContent = t ? t.artist : 'Pick a track to start';
  $$('.pp').forEach(b => { b.innerHTML = `<i class="fa-solid fa-${p ? 'pause' : 'play'}"></i>`; b.setAttribute('aria-label', p ? 'Pause' : 'Play') });
  document.body.classList.toggle('playing', p); fs.classList.toggle('pl', p);
  document.title = t && p ? t.title + ' – Wavelength' : 'Wavelength';
  if (t && t.id !== lastId) {
    lastId = t.id; $('#tc').innerHTML = cover(t); glow(t); fsTrack(t);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.art ? [{ src: art(t), sizes: '512x512', type: t.art.type }] : [] })
  }
  if (!t && lastId) { lastId = null; $('#tc').innerHTML = '<div class="ph">♪</div>'; closeFs() }
  $$('.lk').forEach(b => b.classList.toggle('f', !!(t && t.fav)));
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused'; mark()
}
function mark() {
  $$('#view .row').forEach(r => r.classList.toggle('on', r.dataset.id === queue[qi]));
  $$('[data-v]').forEach(b => b.setAttribute('aria-current', b.dataset.v === view))
}
/* smooth progress bar: updated every frame while playing */
const bar = () => { if (sk || !au.duration) return; const v = au.currentTime / au.duration * 1000; $$('.sk').forEach(s => { s.firstElementChild.value = v; s.style.setProperty('--p', v / 10 + '%') }) };
(function f() { if (!au.paused) { bar(); sync() } requestAnimationFrame(f) })();
au.onplay = au.onpause = ui; au.onwaiting = () => $('#bar').classList.add('busy'); au.oncanplay = () => $('#bar').classList.remove('busy');
au.onended = () => step(1, true);
au.onerror = () => { if (au.src) toast('This file could not be loaded.') };
au.onloadedmetadata = () => $$('.du').forEach(e => e.textContent = fmt(au.duration));
au.ontimeupdate = () => { $$('.cu').forEach(e => e.textContent = fmt(au.currentTime)); bar(); sync() };
document.addEventListener('input', e => {
  const i = e.target; if (!i.matches('.sk input')) return; sk = true;
  $$('.sk').forEach(s => { s.firstElementChild.value = i.value; s.style.setProperty('--p', i.value / 10 + '%') });
  if (au.duration) au.currentTime = i.value / 1000 * au.duration
});
document.addEventListener('change', e => { if (e.target.matches('.sk input')) sk = false });
addEventListener('pointerup', () => sk = false);
document.addEventListener('pointermove', e => {
  const s = e.target.closest && e.target.closest('.sk'); if (!s || !au.duration) return;
  const r = s.getBoundingClientRect(), p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  s.style.setProperty('--tx', p * 100 + '%'); s.querySelector('.tip').textContent = fmt(p * au.duration)
});
$('#vol').oninput = e => { au.volume = +e.target.value; S.vol = au.volume; save(); e.target.style.setProperty('--p', e.target.value * 100 + '%') };
$('#spd').onchange = e => { au.playbackRate = +e.target.value; S.spd = e.target.value; save() };
if ('mediaSession' in navigator) { const m = navigator.mediaSession;[['play', () => au.play()], ['pause', () => au.pause()], ['previoustrack', () => prev()], ['nexttrack', () => step(1)], ['seekto', e => au.currentTime = e.seekTime]].forEach(([k, f]) => { try { m.setActionHandler(k, f) } catch { } }) }
const prev = () => au.currentTime > 3 ? au.currentTime = 0 : step(-1);
/* ---------- full-screen player ---------- */
function fsTrack(t) {
  $('#fa').innerHTML = cover(t); $('#ft').textContent = t.title; $('#fr').textContent = t.artist;
  const u = art(t); $('#fsbg').style.backgroundImage = u ? `url(${u})` : ''; upNext();
  if (fs.classList.contains('open')) lyrics(t)
}
function openFs(push = true) {
  const t = cur(); if (!t) return toast('Pick a track to start');
  fs.classList.add('open'); fs.setAttribute('aria-hidden', 'false'); if (push) history.pushState({ fs: 1 }, '');
  if (lyId !== t.id) lyrics(t); fs.querySelector('[data-a=close]').focus({ preventScroll: true })
}
function closeFs(back = true) {
  if (!fs.classList.contains('open')) return; fs.classList.remove('open'); fs.setAttribute('aria-hidden', 'true');
  if (back && history.state && history.state.fs) history.back()
}
addEventListener('popstate', () => closeFs(false));
/* ---------- lyrics: fetched once from LRCLIB (free public API), then stored on this device ---------- */
const parseLrc = s => { const o = []; s.split(/\r?\n/).forEach(l => { const x = l.replace(/\[[^\]]*\]/g, '').trim(); [...l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)].forEach(k => o.push({ t: +k[1] * 60 + +k[2], x })) }); return o.sort((a, b) => a.t - b.t) };
async function lyrics(t) {
  const my = lyId = t.id; L = null; li = -1; let off = false;
  LY.innerHTML = '<p class="ln pl">Searching for lyrics…</p>';
  let r = await req('lyrics', 'readonly', s => s.get(t.id)).catch(() => null);
  if (!r) {
    try {
      const p = new URLSearchParams({ track_name: t.title }); if (!/^Unknown/.test(t.artist)) p.set('artist_name', t.artist);
      const j = await (await fetch('https://lrclib.net/api/search?' + p)).json(), h = j.find(x => x.syncedLyrics) || j[0];
      if (h && (h.syncedLyrics || h.plainLyrics)) { r = { id: t.id, lrc: h.syncedLyrics || '', plain: h.plainLyrics || '' }; put('lyrics', r) }
    } catch { off = !navigator.onLine }
  }
  if (lyId === my) showLy(r, off)
}
function showLy(r, off) {
  li = -1; L = null;
  if (r && r.lrc && (L = parseLrc(r.lrc)).length) LY.innerHTML = L.map(l => `<p class="ln" data-t="${l.t}">${esc(l.x) || '♪'}</p>`).join('');
  else { L = null; LY.innerHTML = r && (r.plain || r.lrc) ? (r.plain || r.lrc).split(/\r?\n/).map(l => `<p class="ln pl">${esc(l) || '&nbsp;'}</p>`).join('') : `<p class="ln pl">${off ? 'You are offline. Connect to the internet to fetch lyrics.' : 'No lyrics found for this track.'}</p><button class="btn g" data-a="paste">Add lyrics</button>` }
  LY.scrollTop = 0; sync()
}
function sync() {
  if (!L || !fs.classList.contains('open')) return; const c = au.currentTime + .25; let i = -1; for (let k = 0; k < L.length && L[k].t <= c; k++) i = k;
  if (i === li) return; li = i; LY.querySelectorAll('.on').forEach(e => e.classList.remove('on')); const e = LY.children[i];
  if (e) { e.classList.add('on'); LY.scrollTo({ top: e.offsetTop - LY.clientHeight / 2 + e.clientHeight / 2 }) }
}
function lyAsk() {
  const t = cur(); if (!t) return;
  ask(`<h3>Lyrics: ${esc(t.title)}</h3><textarea name="l" rows="9" placeholder="Paste lyrics here. Lines that start with [mm:ss.xx] will highlight in sync."></textarea>`, f => {
    const s = (f.get('l') || '').trim(); if (!s) return; const r = { id: t.id, lrc: /\[\d+:\d+/.test(s) ? s : '', plain: s }; put('lyrics', r); showLy(r); toast('Lyrics saved')
  })
}
/* ---------- mobile feature: swipe & tap gestures on the artwork ---------- */
(() => {
  const a = $('#fa'); let x0, y0, tp = 0;
  a.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY }, { passive: true });
  a.addEventListener('touchend', e => {
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { buzz(); a.style.setProperty('--dx', dx < 0 ? -1 : 1); a.classList.remove('fk'); void a.offsetWidth; a.classList.add('fk'); step(dx < 0 ? 1 : -1) }
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeFs();
    else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const n = Date.now(); if (n - tp < 300) { const r = a.getBoundingClientRect(), d = t.clientX < r.left + r.width / 2 ? -10 : 10; au.currentTime = Math.max(0, au.currentTime + d); buzz(); toast(d > 0 ? '+10 seconds' : '−10 seconds') } tp = n
    }
  })
})();
/* ---------- PC feature: command palette (Ctrl/⌘ + K) ---------- */
function pal() {
  const A = [['Play / Pause', 'play'], ['Next track', 'next'], ['Previous track', 'prev'], ['Cycle loop mode', 'repeat'], ['Toggle shuffle', 'shuffle'], ['Open full-screen player', 'open'], ['Import music', 'import'], ['Switch theme', 'theme']].map(([n, a]) => ({ n, f: () => a === 'theme' ? $('#theme').click() : act(a) }));
  ['home', 'library', 'liked', 'recent', 'most', 'queue'].forEach(v => A.push({ n: 'Go to ' + v, f: () => go(v) }));
  const T = [...tracks].sort(SORT.added).map(t => ({ n: t.title + ' · ' + t.artist, f: () => { queue = [...tracks].sort(SORT.added).map(x => x.id); play(queue.indexOf(t.id)) } }));
  let s = 0, m = [];
  dlg.className = 'pal'; dlg.onclose = null; dlg.onclick = e => { if (e.target === dlg) dlg.close() };
  dlg.innerHTML = '<input type="text" id="pq" placeholder="Search tracks or type a command…" autocomplete="off" aria-label="Command palette"><div id="pr"></div>';
  const draw = () => { const k = $('#pq').value.toLowerCase(); m = [...A, ...T].filter(x => x.n.toLowerCase().includes(k)).slice(0, 8); s = Math.min(s, Math.max(0, m.length - 1)); $('#pr').innerHTML = m.map((x, i) => `<button data-i="${i}" class="${i === s ? 'on' : ''}">${esc(x.n)}</button>`).join('') || '<p class="mut">No matches</p>' };
  const run = i => { const x = m[i]; dlg.close(); if (x) x.f() };
  $('#pq').oninput = () => { s = 0; draw() };
  $('#pq').onkeydown = e => { if (e.key === 'ArrowDown') { s = Math.min(s + 1, m.length - 1); draw(); e.preventDefault() } else if (e.key === 'ArrowUp') { s = Math.max(s - 1, 0); draw(); e.preventDefault() } else if (e.key === 'Enter') run(s) };
  $('#pr').onclick = e => { const b = e.target.closest('[data-i]'); if (b) run(+b.dataset.i) };
  draw(); dlg.showModal()
}
/* ---------- views ---------- */
const row = (t, i = 0) => { const pl = view.startsWith('playlist'); return `<div class="row${queue[qi] === t.id ? ' on' : ''}" style="--i:${Math.min(i, 14)}" data-id="${t.id}" tabindex="0"><div class="cv">${cover(t)}</div><div class="mt"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div><span class="du">${fmt(t.dur)}</span><div class="acts"><button data-a="fav" class="${t.fav ? 'f' : ''}" aria-pressed="${!!t.fav}" aria-label="Like" title="Like">♥</button><button data-a="pnext" aria-label="Play next" title="Play next">⤵</button><button data-a="q" aria-label="Add to queue" title="Add to queue">＋</button><button data-a="pl" aria-label="Add to playlist" title="Add to playlist">☰</button><button data-a="ed" aria-label="Edit details" title="Edit details">✎</button><button data-a="rm" aria-label="${pl ? 'Remove from playlist' : 'Delete from library'}" title="${pl ? 'Remove from playlist' : 'Delete from library'}">✕</button></div></div>` };
function render() {
  const v = $('#view'), [k, id] = view.split(':'), lc = q.toLowerCase(), byAdd = [...tracks].sort(SORT.added); let list = [], head = '', extra = '';
  if (!tracks.length && k !== 'playlist') { shown = []; v.innerHTML = '<div class="empty"><h2>Your library is empty</h2><p class="mut">Import audio files from this device. They are saved in your browser and play offline.</p><button class="btn" data-a="import">Import music</button><p class="mut">You can also drag and drop files anywhere.</p></div>'; mark(); return }
  if (k === 'home') {
    shown = byAdd.map(t => t.id); const most = tracks.filter(t => t.plays).sort((x, y) => y.plays - x.plays).slice(0, 5);
    v.innerHTML = `<h2>Recently added</h2><div class="grid">${byAdd.slice(0, 12).map((t, i) => `<button class="card" style="--i:${i}" data-id="${t.id}"><div class="cv">${cover(t)}</div><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></button>`).join('')}</div>${most.length ? `<h2>Most played</h2><div class="list">${most.map(row).join('')}</div>` : ''}`; mark(); return
  }
  if (k === 'library') { list = [...tracks].sort(SORT[sort]); head = 'Your library' }
  else if (k === 'liked') { list = byAdd.filter(t => t.fav); head = 'Liked songs' }
  else if (k === 'recent') { list = tracks.filter(t => t.last).sort((x, y) => y.last - x.last); head = 'Recently played' }
  else if (k === 'most') { list = tracks.filter(t => t.plays).sort((x, y) => y.plays - x.plays); head = 'Most played' }
  else if (k === 'queue') { list = queue.map(i => tracks.find(t => t.id === i)).filter(Boolean); head = 'Queue' }
  else if (k === 'search') { list = byAdd.filter(t => [t.title, t.artist, t.album].some(s => s.toLowerCase().includes(lc))); head = 'Results for “' + esc(q) + '”'; const pm = lists.filter(l => l.name.toLowerCase().includes(lc)); extra = pm.length ? `<div class="chips">${pm.map(l => `<button class="chip" data-v="playlist:${l.id}">${esc(l.name)}</button>`).join('')}</div>` : '' }
  else if (k === 'playlist') { const l = lists.find(x => x.id === id); if (!l) { view = 'home'; return render() } list = l.ids.map(i => tracks.find(t => t.id === i)).filter(Boolean); head = esc(l.name); extra = '<div class="chips"><button class="chip" data-a="plren">Rename</button><button class="chip" data-a="pldel">Delete playlist</button></div>' }
  shown = list.map(t => t.id);
  const sel = k === 'library' ? `<select id="sort" aria-label="Sort by">${[['added', 'Date added'], ['title', 'Title'], ['artist', 'Artist'], ['dur', 'Duration']].map(([a, b]) => `<option value="${a}"${a === sort ? ' selected' : ''}>${b}</option>`).join('')}</select>` : '';
  v.innerHTML = `<div class="hd"><h2>${head}</h2>${sel}${list.length ? '<button class="btn" data-a="playall">Play all</button>' : ''}</div>${extra}<div class="list">${list.map(row).join('') || '<p class="mut">Nothing here yet.</p>'}</div>`; mark()
}
function navPl() { $('#pls').innerHTML = lists.map(l => `<button data-v="playlist:${l.id}">${esc(l.name)}</button>`).join(''); mark() }
function go(v) { view = v; if (!v.startsWith('search')) { q = ''; $('#q').value = '' } const s = $('#view'); s.classList.remove('in'); void s.offsetWidth; s.classList.add('in'); render(); $('main').scrollTop = 0 }
/* ---------- dialogs & actions ---------- */
const dlg = $('#dlg');
function ask(html, ok, label = 'Save') { dlg.className = ''; dlg.onclick = null; dlg.innerHTML = `<form method="dialog">${html}<menu><button value="x" class="btn g">Cancel</button><button value="ok" class="btn">${label}</button></menu></form>`; dlg.returnValue = ''; dlg.onclose = () => { if (dlg.returnValue === 'ok') ok(new FormData(dlg.querySelector('form'))) }; dlg.showModal() }
function newpl(tid) { ask('<h3>New playlist</h3><input type="text" name="n" placeholder="Playlist name" required autofocus aria-label="Playlist name">', f => { const n = (f.get('n') || '').trim(); if (!n) return; const l = { id: crypto.randomUUID(), name: n, ids: tid ? [tid] : [] }; lists.push(l); put('lists', l); navPl(); toast('Created ' + n) }, 'Create') }
function act(k, id) {
  const t = tracks.find(x => x.id === id); switch (k) {
    case 'import': $('#file').click(); break;
    case 'play': if (qi < 0) { if (shown.length) { queue = shown.slice(); play(0) } else toast('Import music to start playing') } else au.paused ? au.play().catch(() => { }) : au.pause(); break;
    case 'prev': prev(); break; case 'next': step(1); break;
    case 'shuffle': shuffle = !shuffle; S.sh = shuffle; save(); $$('.shf').forEach(b => b.setAttribute('aria-pressed', shuffle)); break;
    case 'repeat': repeat = (repeat + 1) % 3; S.lp = repeat; save(); repUi(); toast(['Loop off', 'Looping this track', 'Looping all tracks'][repeat]); break;
    case 'mute': au.muted = !au.muted; $('#mt').textContent = au.muted ? 'Muted' : 'Vol'; break;
    case 'playall': queue = shown.slice(); play(0); break;
    case 'open': openFs(); break; case 'close': closeFs(); break; case 'lyr': fs.classList.toggle('ly'); break;
    case 'paste': lyAsk(); break; case 'pal': pal(); break;
    case 'ffav': { const c = cur(); if (c) { c.fav = c.fav ? 0 : 1; saveStat(c); ui(); render() } break }
    case 'fav': t.fav = t.fav ? 0 : 1; saveStat(t); ui(); render(); break;
    case 'pnext': if (!queue.length) { queue = [id]; play(0) } else queue.splice(qi + 1, 0, id); toast('Playing next'); break;
    case 'q': queue.push(id); if (qi < 0) play(0); toast('Added to queue'); break;
    case 'pl': if (!lists.length) { newpl(id); break } ask(`<h3>Add to playlist</h3><select name="l" aria-label="Playlist">${lists.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>`, f => { const l = lists.find(x => x.id === f.get('l')); if (!l.ids.includes(id)) l.ids.push(id); put('lists', l); toast('Added to ' + l.name) }, 'Add'); break;
    case 'ed': ask(`<h3>Edit details</h3>${[['title', 'Title'], ['artist', 'Artist'], ['album', 'Album']].map(([n, l]) => `<input type="text" name="${n}" value="${esc(t[n])}" aria-label="${l}" placeholder="${l}">`).join('')}`, f => { ['title', 'artist', 'album'].forEach(n => t[n] = (f.get(n) || '').trim() || t[n]); put('tracks', t).then(() => { lastId = null; ui(); render() }) }); break;
    case 'rm': {
      if (view.startsWith('playlist')) { const l = lists.find(x => x.id === view.split(':')[1]); l.ids = l.ids.filter(i => i !== id); put('lists', l); render(); break }
      if (!confirm(`Delete "${t.title}" from this device? Your original file is not affected.`)) break;
      const c = queue[qi]; del('tracks', id).then(() => {
        del('lyrics', id).catch(() => { });
        tracks = tracks.filter(x => x.id !== id); delete stats[id]; localStorage.wlst = JSON.stringify(stats); lists.forEach(l => { if (l.ids.includes(id)) { l.ids = l.ids.filter(i => i !== id); put('lists', l) } }); queue = queue.filter(i => i !== id);
        if (c === id) { au.pause(); au.removeAttribute('src'); qi = -1; lastId = null } else qi = queue.indexOf(c); ui(); render(); usage()
      }).catch(() => toast('Could not delete this track')); break
    }
    case 'newpl': newpl(); break;
    case 'plren': { const l = lists.find(x => x.id === view.split(':')[1]); ask(`<h3>Rename playlist</h3><input type="text" name="n" value="${esc(l.name)}" aria-label="Playlist name" required>`, f => { l.name = (f.get('n') || '').trim() || l.name; put('lists', l); navPl(); render() }); break }
    case 'pldel': { const l = lists.find(x => x.id === view.split(':')[1]); if (confirm(`Delete playlist "${l.name}"? Tracks stay in your library.`)) del('lists', l.id).then(() => { lists = lists.filter(x => x !== l); navPl(); go('library') }); break }
    case 'wipe': if (confirm('Delete your entire library, playlists and play history from this browser? This cannot be undone.')) Promise.all([req('tracks', 'readwrite', s => s.clear()), req('lists', 'readwrite', s => s.clear()), req('lyrics', 'readwrite', s => s.clear())]).then(() => { au.pause(); au.removeAttribute('src'); tracks = []; lists = []; queue = []; qi = -1; lastId = null; lyId = null; localStorage.removeItem('wlst'); navPl(); ui(); go('home'); usage(); toast('Library deleted') }); break
  }
}
const repUi = () => { au.loop = repeat === 1; $$('.rep').forEach(r => { r.innerHTML = '<i class="fa-solid fa-repeat"></i>' + (repeat === 1 ? '<sup>1</sup>' : ''); r.classList.toggle('on', repeat > 0); r.setAttribute('aria-pressed', repeat > 0); r.setAttribute('aria-label', ['Loop off', 'Loop this track', 'Loop all tracks'][repeat]) }); upNext() };
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'), vv = e.target.closest('[data-v]'), r = e.target.closest('[data-id]'), ln = e.target.closest('.ln[data-t]');
  if (ln) { au.currentTime = +ln.dataset.t; if (au.paused) au.play(); return }
  if (vv) return go(vv.dataset.v); if (b) return act(b.dataset.a, r && r.dataset.id);
  if (r) { queue = shown.slice(); return play(queue.indexOf(r.dataset.id)) }
  if (e.target.closest('#bar') && !e.target.closest('input,select,.sk')) openFs() /* one click anywhere on the bar opens the full-screen player */
});
document.addEventListener('change', e => { if (e.target.id === 'sort') { sort = e.target.value; render() } });
$('#file').onchange = e => { imp([...e.target.files]); e.target.value = '' };
addEventListener('dragover', e => e.preventDefault()); addEventListener('drop', e => { e.preventDefault(); imp([...e.dataTransfer.files]) });
let qh; $('#q').oninput = e => { clearTimeout(qh); qh = setTimeout(() => { q = e.target.value.trim(); view = q ? 'search' : 'home'; render() }, 150) };
$('#theme').onclick = () => { const d = document.documentElement, n = d.dataset.theme === 'dark' ? 'light' : 'dark'; d.dataset.theme = n; S.th = n; save() };
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dlg.open ? dlg.close() : pal(); return }
  if (dlg.open) return; const el = e.target;
  if (e.key === 'Escape' && fs.classList.contains('open')) { closeFs(); return }
  if (e.key === 'Enter' && el.matches('.row,.now')) { el.click(); return }
  if (/INPUT|SELECT|TEXTAREA/.test(el.tagName)) return;
  if (e.code === 'Space' && el.tagName !== 'BUTTON') { e.preventDefault(); act('play') }
  else if (e.key === 'ArrowRight') e.shiftKey ? step(1) : au.currentTime += 5;
  else if (e.key === 'ArrowLeft') e.shiftKey ? prev() : au.currentTime -= 5;
  else if (e.key === 'm') act('mute'); else if (e.key === 'l') act('repeat'); else if (e.key === 'f') openFs();
  else if (e.key === '/') { e.preventDefault(); $('#q').focus() }
});
const net = () => $('#net').hidden = navigator.onLine; addEventListener('online', net); addEventListener('offline', net);
function usage() { navigator.storage?.estimate?.().then(e => $('#sto').textContent = `${(e.usage / 1048576).toFixed(1)} MB used of ${(e.quota / 1073741824).toFixed(1)} GB. Browsers can clear site storage, so keep your originals.`) }
/* ---------- boot ---------- */
(async () => {
  $('#mb').innerHTML = $('#sb').innerHTML;
  document.documentElement.dataset.theme = S.th || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  au.volume = S.vol ?? 1; $('#vol').value = au.volume; $('#vol').style.setProperty('--p', au.volume * 100 + '%'); $('#spd').value = S.spd || '1'; shuffle = !!S.sh; repeat = S.lp || 0; $$('.shf').forEach(b => b.setAttribute('aria-pressed', shuffle)); repUi(); net();
  try { tracks = await all('tracks'); lists = await all('lists') } catch { toast('Storage is unavailable. Your library cannot be saved in this browser mode.') }
  tracks.forEach(t => { const s = stats[t.id]; if (s) { t.plays = s.p; t.last = s.l; t.fav = s.f } });
  navPl(); render(); usage();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
