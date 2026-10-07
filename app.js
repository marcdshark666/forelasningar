/* Föreläsningar – gränssnitt. Allt lagras lokalt i IndexedDB; inga nätverksanrop. */
(function () {
  'use strict';
  const F = window.Forelasningar;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const app = $('#app');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const SRC_LABEL = { exif: 'EXIF', filnamn: 'filnamn', filtid: 'filtid', saknas: 'ingen tid' };
  const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('sv-SE', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + F.fmtClock(d); };

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function fail(err, context) {
    console.error(context || 'Fel', err);
    toast(`${context ? context + ': ' : ''}${err && err.message ? err.message : err}`);
  }

  /* ---------- tema ---------- */
  const THEMES = ['auto', 'light', 'dark'];
  function readLS(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privat läge: tema sparas inte */ } }
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('#theme').title = `Tema: ${{ auto: 'följer systemet', light: 'ljust', dark: 'mörkt' }[t]}`;
  }
  let theme = readLS('forel-tema', 'auto'); if (!THEMES.includes(theme)) theme = 'auto';
  applyTheme(theme);
  $('#theme').addEventListener('click', () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; writeLS('forel-tema', theme); applyTheme(theme); toast($('#theme').title); });

  /* ---------- IndexedDB ---------- */
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('Webbläsaren saknar IndexedDB.')); return; }
      const req = indexedDB.open('forelasningar', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('lectures')) d.createObjectStore('lectures', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' }).createIndex('lectureId', 'lectureId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Kunde inte öppna databasen.'));
    });
    return dbp;
  }
  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Avbruten transaktion (lagringen kan vara full).')); }); }
  const store = {
    async all() { const d = await db(); return reqP(d.transaction('lectures').objectStore('lectures').getAll()); },
    async get(id) { const d = await db(); return reqP(d.transaction('lectures').objectStore('lectures').get(id)); },
    async put(lecture) { const d = await db(); const tx = d.transaction('lectures', 'readwrite'); tx.objectStore('lectures').put(lecture); return txDone(tx); },
    async image(id) { const d = await db(); return reqP(d.transaction('images').objectStore('images').get(id)); },
    async saveLecture(lecture, newImages, removedImageIds) {
      const d = await db(); const tx = d.transaction(['lectures', 'images'], 'readwrite');
      tx.objectStore('lectures').put(lecture);
      for (const img of newImages || []) tx.objectStore('images').put(img);
      for (const id of removedImageIds || []) tx.objectStore('images').delete(id);
      return txDone(tx);
    },
    async remove(id) {
      const d = await db(); const tx = d.transaction(['lectures', 'images'], 'readwrite');
      tx.objectStore('lectures').delete(id);
      const keys = await reqP(tx.objectStore('images').index('lectureId').getAllKeys(id));
      keys.forEach((k) => tx.objectStore('images').delete(k));
      return txDone(tx);
    },
  };

  /* object-URL:er för bilder i aktuell vy */
  let urls = new Map();
  function releaseUrls() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = new Map(); }
  async function imageUrl(id) {
    if (!id) return null;
    if (urls.has(id)) return urls.get(id);
    const rec = await store.image(id);
    if (!rec || !rec.blob) return null;
    const u = URL.createObjectURL(rec.blob); urls.set(id, u); return u;
  }
  async function imageUrls(ids) { const out = {}; await Promise.all(ids.map(async (id) => { out[id] = await imageUrl(id); })); return out; }

  function lectureModel(rec) {
    return F.buildLecture({ title: rec.title, recordingStartedAt: rec.startedAt, transcript: rec.transcript, notes: rec.notes,
      photos: rec.photos, offsetSec: rec.offsetSec, chunkSec: rec.chunkSec });
  }

  /* ---------- router ---------- */
  let cleanup = null;
  async function route() {
    if (cleanup) { try { cleanup(); } catch (e) { console.warn(e); } cleanup = null; }
    releaseUrls();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (!parts.length) await viewLibrary();
      else if (parts[0] === 'ny') await viewEditor(null);
      else if (parts[0] === 'redigera' && parts[1]) await viewEditor(parts[1]);
      else if (parts[0] === 'f' && parts[1] && parts[2] === 'kort') await viewStudy(parts[1], parts[3] === 'alla');
      else if (parts[0] === 'f' && parts[1] && parts[2] === 'kortlista') await viewCardList(parts[1]);
      else if (parts[0] === 'f' && parts[1]) await viewLecture(parts[1]);
      else location.hash = '#/';
    } catch (e) {
      app.innerHTML = `<div class="panel warn"><h2>Något gick fel</h2><p>${esc(e.message || e)}</p><a class="btn" href="#/">Till biblioteket</a></div>`;
      console.error(e);
    }
    app.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  /* ---------- bibliotek ---------- */
  async function viewLibrary() {
    document.title = 'Föreläsningar';
    const list = (await store.all()).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const now = Date.now();
    const thumbs = await imageUrls(list.map((l) => l.photos && l.photos[0] && l.photos[0].id).filter(Boolean));
    app.innerHTML = `
      <div class="spread"><h1>Mina föreläsningar</h1>
        <div class="row">
          <a class="btn" href="#/ny">+ Ny föreläsning</a>
          <label class="btn ghost" style="margin:0">Importera<input type="file" id="imp" accept=".json,application/json" hidden></label>
          ${list.length ? '<button class="btn ghost" id="expall" type="button">Exportera alla</button>' : ''}
        </div></div>
      <p class="privacy">Allt sparas bara i den här webbläsaren. Inget laddas upp automatiskt – bilderna kan vara patientnära eller föreställa andra, så dela exportfiler med eftertanke.</p>
      ${list.length ? `<div class="lib">${list.map((l) => {
        const due = F.dueCards(l.cards, l.progress, now).length;
        const t = l.photos && l.photos[0] && thumbs[l.photos[0].id];
        return `<a class="panel lib-item" href="#/f/${encodeURIComponent(l.id)}">
          <div class="thumb" ${t ? `style="background-image:url('${t}')"` : ''}></div>
          <h3>${esc(l.title)}</h3>
          <span class="muted small">${esc(fmtDate(l.startedAt))}</span>
          <span class="row"><span class="chip">${(l.photos || []).length} bilder</span><span class="chip">${(l.cards || []).length} kort</span>${due ? `<span class="chip note">${due} att repetera</span>` : ''}</span>
        </a>`; }).join('')}</div>`
      : `<div class="panel empty"><h2>Inga föreläsningar än</h2><p class="muted">Skriv anteckningar live under föreläsningen, eller lägg in PLAUD-transkriptet efteråt – och välj bilderna du tog. De hamnar på rätt plats i tidslinjen.</p><a class="btn" href="#/ny">Skapa den första</a></div>`}`;
    $('#imp').addEventListener('change', (e) => importFile(e.target.files[0]).catch((err) => fail(err, 'Import')));
    const ea = $('#expall'); if (ea) ea.addEventListener('click', () => exportLectures(list).catch((err) => fail(err, 'Export')));
  }

  /* ---------- export / import ---------- */
  function blobToDataUrl(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
  async function dataUrlToBlob(url) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url || ''));
    if (!m) throw new Error('Ogiltig bilddata i filen.');
    const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] || 'image/jpeg' });
  }
  async function exportLectures(list) {
    toast('Packar exportfilen …');
    const out = { app: 'forelasningar', version: 1, exportedAt: new Date().toISOString(), lectures: [] };
    for (const l of list) {
      const images = [];
      for (const p of l.photos || []) { const rec = await store.image(p.id); if (rec && rec.blob) images.push({ id: p.id, type: rec.blob.type, data: await blobToDataUrl(rec.blob) }); }
      out.lectures.push({ ...l, images });
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const name = list.length === 1 ? list[0].title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'forelasning' : 'forelasningar';
    a.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 1024 * 1024 * 1024) throw new Error('Filen är för stor (över 1 GB).');
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('Filen är inte giltig JSON.'); }
    if (!data || data.app !== 'forelasningar' || !Array.isArray(data.lectures)) throw new Error('Det här är ingen exportfil från Föreläsningar.');
    const existing = new Set((await store.all()).map((l) => l.id));
    let count = 0;
    for (const raw of data.lectures) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue;
      if (existing.has(raw.id) && !confirm(`"${raw.title}" finns redan. Skriva över den?`)) continue;
      const { images = [], ...lecture } = raw;
      lecture.photos = Array.isArray(lecture.photos) ? lecture.photos : [];
      lecture.cards = Array.isArray(lecture.cards) ? lecture.cards : [];
      lecture.progress = lecture.progress && typeof lecture.progress === 'object' ? lecture.progress : {};
      const imgs = [];
      for (const im of images) if (im && typeof im.id === 'string') imgs.push({ id: im.id, lectureId: lecture.id, blob: await dataUrlToBlob(im.data) });
      if (existing.has(raw.id)) await store.remove(raw.id);
      await store.saveLecture(lecture, imgs, []);
      count++;
    }
    toast(`${count} föreläsning${count === 1 ? '' : 'ar'} importerade`);
    route();
  }

  /* ---------- bilder in ---------- */
  async function shrink(file, maxSide) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      if (scale >= 1 && file.size < 1.5e6) { bmp.close && bmp.close(); return file; }
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.85));
    } catch (e) { console.warn('Kunde inte förminska', file.name, e); return file; }
  }
  async function ingestPhoto(file, doShrink) {
    let exif = null;
    if (/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)) {
      try { exif = F.exifDateFromJpeg(new Uint8Array(await file.slice(0, 262144).arrayBuffer())); } catch (e) { exif = null; }
    }
    const t = F.photoTime({ exif, name: file.name, lastModified: file.lastModified });
    const blob = doShrink ? await shrink(file, 2000) : file;
    return { id: uid('bild'), name: file.name, takenAt: t.takenAt ? t.takenAt.toISOString() : null, source: t.source, blob };
  }

  /* ---------- redigerare ---------- */
  async function viewEditor(id) {
    const existing = id ? await store.get(id) : null;
    if (id && !existing) throw new Error('Föreläsningen finns inte.');
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: uid('forel'), title: '', startedAt: null, transcript: '', transcriptName: '', notes: '', offsetSec: 0, chunkSec: 60,
      photos: [], cards: [], progress: {}, createdAt: new Date().toISOString(),
    };
    const newBlobs = new Map(); // id -> blob (ej sparade än)
    const removed = new Set();
    let dirty = false;
    document.title = existing ? `Redigera · ${existing.title}` : 'Ny föreläsning';
    const startVal = draft.startedAt ? F.toLocalInput(draft.startedAt) : '';
    app.innerHTML = `
      <h1>${existing ? 'Redigera föreläsning' : 'Ny föreläsning'}</h1>
      <p class="privacy">Allt du lägger in här stannar i den här webbläsaren. Inget laddas upp.</p>
      <section class="panel">
        <div class="grid2">
          <div><label for="e-title">Titel</label><input type="text" id="e-title" maxlength="200" placeholder="t.ex. Kardiologi – hjärtsvikt" value="${esc(draft.title)}"></div>
          <div><label for="e-start">Inspelningen började <span class="hint">(datum och klockslag)</span></label><input type="datetime-local" id="e-start" step="1" value="${esc(startVal)}"></div>
        </div>
        <p class="hint" id="start-hint">Tiden gissas från PLAUD-filens namn om det innehåller datum och klockslag.</p>
      </section>

      <section class="panel">
        <h2>Underlag</h2>
        <label for="e-file">PLAUD-transkript <span class="hint">(.srt, .vtt eller .txt med tidsstämplar)</span></label>
        <input type="file" id="e-file" accept=".srt,.vtt,.txt,text/plain,text/vtt">
        <p class="hint" id="file-info">${draft.transcriptName ? `Inläst: ${esc(draft.transcriptName)} <button class="btn ghost" id="file-clear" type="button" style="min-height:30px;padding:2px 10px">Ta bort</button>` : 'Inget transkript valt.'}</p>
        <div class="spread" style="margin-top:12px">
          <label for="e-notes" style="margin:0">Egna anteckningar</label>
          <button class="btn ghost" id="live-on" type="button">● Live-anteckning</button>
        </div>
        <p class="hint">En rad per anteckning. Börja gärna med klockslag: <code>10:15 Hjärtsvikt – NYHA I–IV</code>. Rader utan tid fördelas jämnt mellan närmaste tider.</p>
        <div id="live" hidden></div>
        <textarea id="e-notes" placeholder="10:05 Introduktion&#10;10:12 Patofysiologi: minskad ejektionsfraktion&#10;Diuretika vid stas">${esc(draft.notes)}</textarea>
        <label for="e-chunk">Transkriptets avsnittslängd <span class="hint">(slå ihop korta PLAUD-rader)</span></label>
        <select id="e-chunk">${[[0, 'Varje rad för sig'], [30, '30 sekunder'], [60, '1 minut'], [120, '2 minuter'], [300, '5 minuter']].map(([v, t]) => `<option value="${v}" ${+draft.chunkSec === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </section>

      <section class="panel">
        <h2>Bilder</h2>
        <label for="e-photos">Välj bilder <span class="hint">(t.ex. från Syncthing-mappen)</span></label>
        <input type="file" id="e-photos" accept="image/*" multiple>
        <label class="hint" style="font-weight:600"><input type="checkbox" id="e-shrink" checked> Förminska till max 2000 px (sparar utrymme; tiden läses före förminskningen)</label>
        <p class="hint">Tid tas i första hand ur EXIF, annars ur filnamnet (IMG_20261007_101530, PXL_…), annars filens ändringstid – källan visas på varje bild.</p>
        <div class="plist" id="plist"></div>
      </section>

      <section class="panel">
        <h2>Klockjustering</h2>
        <p class="hint">Går kamerans klocka före eller efter inspelningen? Dra tills bilderna hamnar vid rätt text. Positivt värde flyttar bilderna senare.</p>
        <div class="offset">
          <button class="btn ghost icon" type="button" data-nudge="-1" aria-label="En sekund tidigare">−</button>
          <input type="range" id="e-offset" min="-900" max="900" step="1" value="${+draft.offsetSec || 0}" aria-label="Tidsförskjutning i sekunder">
          <button class="btn ghost icon" type="button" data-nudge="1" aria-label="En sekund senare">+</button>
        </div>
        <div class="row" style="justify-content:center;margin-top:6px">
          <span class="offset-val" id="offset-val"></span>
          <label class="hint" style="margin:0">min <input type="number" id="e-off-min" style="width:80px" step="1"></label>
          <label class="hint" style="margin:0">s <input type="number" id="e-off-sec" style="width:80px" step="1"></label>
        </div>
        <div class="nudges">${[-600, -60, -10, 10, 60, 600].map((v) => `<button class="btn ghost" type="button" data-nudge="${v}">${v > 0 ? '+' : '−'}${Math.abs(v) >= 60 ? Math.abs(v) / 60 + ' min' : Math.abs(v) + ' s'}</button>`).join('')}<button class="btn ghost" type="button" id="off-reset">Nollställ</button></div>
      </section>

      <section class="panel">
        <div class="spread"><h2>Förhandsvisning</h2><span class="muted small" id="pv-stats"></span></div>
        <div id="preview"><p class="muted">Lägg in transkript eller anteckningar och ange starttid.</p></div>
      </section>

      <div class="row" style="position:sticky;bottom:10px;z-index:4">
        <button class="btn" id="save" type="button">Spara föreläsningen</button>
        <a class="btn ghost" href="${existing ? '#/f/' + encodeURIComponent(existing.id) : '#/'}">Avbryt</a>
      </div>`;

    const thumbUrl = (p) => {
      if (newBlobs.has(p.id)) { if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(newBlobs.get(p.id))); return Promise.resolve(urls.get(p.id)); }
      return imageUrl(p.id);
    };
    const markDirty = () => { dirty = true; schedulePreview(); };

    async function renderPhotos() {
      const ps = [...draft.photos].sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
      const u = {}; for (const p of ps) u[p.id] = await thumbUrl(p);
      $('#plist').innerHTML = ps.map((p) => `<figure>
          <img src="${u[p.id] || ''}" alt="${esc(p.name)}" loading="lazy">
          <button class="x" type="button" data-rm="${esc(p.id)}" aria-label="Ta bort ${esc(p.name)}">×</button>
          <figcaption>${esc(p.takenAt ? F.fmtClock(p.takenAt, true) : '–')} <span class="chip src-${esc(p.source)}">${esc(SRC_LABEL[p.source] || p.source)}</span><br><span class="muted">${esc(p.name)}</span></figcaption>
        </figure>`).join('') || '<p class="muted small">Inga bilder valda.</p>';
    }
    $('#plist').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rm]'); if (!b) return;
      const pid = b.dataset.rm;
      draft.photos = draft.photos.filter((p) => p.id !== pid);
      if (newBlobs.has(pid)) newBlobs.delete(pid); else removed.add(pid);
      renderPhotos(); markDirty();
    });

    let pvTimer;
    function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 120); }
    async function renderPreview() {
      const off = +draft.offsetSec || 0, sign = off < 0 ? '−' : '+', a = Math.abs(off);
      $('#offset-val').textContent = `${sign}${Math.floor(a / 60)} min ${a % 60} s`;
      $('#e-offset').value = Math.max(-900, Math.min(900, off));
      if (document.activeElement !== $('#e-off-min') && document.activeElement !== $('#e-off-sec')) {
        $('#e-off-min').value = Math.trunc(off / 60); $('#e-off-sec').value = off % 60;
      }
      const pv = $('#preview');
      if (!draft.startedAt || (!draft.transcript.trim() && !draft.notes.trim())) { pv.innerHTML = '<p class="muted">Lägg in transkript eller anteckningar och ange starttid.</p>'; $('#pv-stats').textContent = ''; return; }
      let model;
      try { model = lectureModel(draft); } catch (e) { pv.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
      const ids = model.sections.flatMap((s) => s.photos.map((p) => p.id)).concat(model.unmatchedPhotos.map((p) => p.id));
      const u = {}; for (const pid of ids) { const p = draft.photos.find((x) => x.id === pid); if (p) u[pid] = await thumbUrl(p); }
      const matched = model.sections.reduce((n, s) => n + s.photos.length, 0);
      $('#pv-stats').textContent = `${model.sections.length} avsnitt · ${matched}/${draft.photos.length} bilder placerade`;
      pv.innerHTML = timelineHtml(model, u, { compact: true }) + unmatchedHtml(model, u);
    }

    // fält
    $('#e-title').addEventListener('input', (e) => { draft.title = e.target.value; dirty = true; });
    $('#e-start').addEventListener('input', (e) => { const d = e.target.value ? new Date(e.target.value) : null; draft.startedAt = d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; markDirty(); });
    $('#e-notes').addEventListener('input', (e) => { draft.notes = e.target.value; markDirty(); });
    $('#e-chunk').addEventListener('change', (e) => { draft.chunkSec = +e.target.value; markDirty(); });
    function bindClear() { const c = $('#file-clear'); if (c) c.addEventListener('click', () => { draft.transcript = ''; draft.transcriptName = ''; $('#file-info').textContent = 'Inget transkript valt.'; markDirty(); }); }
    bindClear();
    $('#e-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        if (f.size > 20 * 1024 * 1024) throw new Error('Transkriptet är större än 20 MB.');
        draft.transcript = await f.text(); draft.transcriptName = f.name;
        $('#file-info').innerHTML = `Inläst: ${esc(f.name)} <button class="btn ghost" id="file-clear" type="button" style="min-height:30px;padding:2px 10px">Ta bort</button>`;
        bindClear();
        const guess = F.timeFromFilename(f.name);
        if (guess) {
          if (!draft.startedAt || confirm(`Filnamnet anger ${guess.toLocaleString('sv-SE')}. Använda det som starttid?`)) {
            draft.startedAt = guess.toISOString(); $('#e-start').value = F.toLocalInput(guess);
            $('#start-hint').textContent = `Starttid gissad från filnamnet (${f.name}).`;
          }
        } else if (!draft.startedAt) $('#start-hint').textContent = 'Filnamnet innehåller ingen tid – ange starttiden själv.';
        if (!draft.title) { draft.title = f.name.replace(/\.[^.]+$/, '').replace(/^\d{4}[-_.]?\d{2}[-_.]?\d{2}[ T_.-]*\d{2}[-_.:]?\d{2}(?:[-_.:]?\d{2})?[\s_-]*/, '').replace(/[_]+/g, ' ').trim() || 'Föreläsning'; $('#e-title').value = draft.title; }
        markDirty();
      } catch (err) { fail(err, 'Transkript'); }
    });
    $('#e-photos').addEventListener('change', async (e) => {
      const files = [...e.target.files]; if (!files.length) return;
      const shrinkOn = $('#e-shrink').checked;
      toast(`Läser ${files.length} bilder …`);
      let n = 0;
      for (const f of files) {
        try { const p = await ingestPhoto(f, shrinkOn); newBlobs.set(p.id, p.blob); delete p.blob; draft.photos.push(p); n++; }
        catch (err) { fail(err, f.name); }
      }
      e.target.value = '';
      if (!draft.startedAt) {
        const first = draft.photos.map((p) => p.takenAt).filter(Boolean).sort()[0];
        if (first) { draft.startedAt = first; $('#e-start').value = F.toLocalInput(first); $('#start-hint').textContent = 'Starttid satt till första bildens tid – justera vid behov.'; }
      }
      toast(`${n} bilder tillagda`); renderPhotos(); markDirty();
    });
    // offset
    const setOffset = (v) => { draft.offsetSec = Math.max(-86400, Math.min(86400, Math.round(+v || 0))); markDirty(); };
    $('#e-offset').addEventListener('input', (e) => setOffset(e.target.value));
    $$('[data-nudge]').forEach((b) => b.addEventListener('click', () => setOffset((+draft.offsetSec || 0) + +b.dataset.nudge)));
    $('#off-reset').addEventListener('click', () => setOffset(0));
    const fromFields = () => setOffset((+$('#e-off-min').value || 0) * 60 + (+$('#e-off-sec').value || 0));
    $('#e-off-min').addEventListener('input', fromFields); $('#e-off-sec').addEventListener('input', fromFields);

    // live-läge
    let liveTimer = null;
    function stopLive() { clearInterval(liveTimer); liveTimer = null; $('#live').hidden = true; $('#live').innerHTML = ''; $('#live-on').textContent = '● Live-anteckning'; }
    $('#live-on').addEventListener('click', () => {
      if (liveTimer) { stopLive(); return; }
      if (!draft.startedAt) { const now = new Date(); now.setMilliseconds(0); draft.startedAt = now.toISOString(); $('#e-start').value = F.toLocalInput(now); $('#start-hint').textContent = 'Starttid satt till när live-anteckningen startade.'; }
      const box = $('#live'); box.hidden = false;
      box.innerHTML = `<div class="panel live"><div class="spread"><span class="live-clock" id="live-clock"></span><span class="hint">Enter sparar raden med aktuell klocktid</span></div>
        <input type="text" class="live-input" id="live-input" placeholder="Skriv och tryck Enter …" autocomplete="off" enterkeyhint="send"></div>`;
      const tick = () => { $('#live-clock').textContent = F.fmtClock(new Date(), true); };
      tick(); liveTimer = setInterval(tick, 1000);
      $('#live-on').textContent = '■ Avsluta live';
      const inp = $('#live-input'); inp.focus();
      inp.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || ev.isComposing) return;
        ev.preventDefault();
        const text = inp.value.trim(); if (!text) return;
        const line = `${F.fmtClock(new Date(), true)} ${text}`;
        draft.notes = (draft.notes && !draft.notes.endsWith('\n') ? draft.notes + '\n' : draft.notes || '') + line + '\n';
        $('#e-notes').value = draft.notes; $('#e-notes').scrollTop = 1e9;
        inp.value = ''; markDirty();
        saveQuiet();
      });
    });
    // autospara under live så inget går förlorat om fliken stängs
    async function saveQuiet() {
      if (!draft.startedAt) return;
      try { await persist(false); } catch (e) { console.warn('Autospar misslyckades', e); }
    }

    async function persist(showToast) {
      if (!draft.title.trim()) draft.title = `Föreläsning ${new Date(draft.startedAt).toLocaleDateString('sv-SE')}`;
      const model = lectureModel(draft);
      // behåll egna/redigerade kort, ersätt autogenererade som inte rörts
      const kept = (draft.cards || []).filter((c) => !c.generated || c.edited);
      const keptSections = new Set(kept.map((c) => c.sectionId).filter(Boolean));
      draft.cards = [...kept, ...F.generateFlashcards(model.sections).filter((c) => !keptSections.has(c.sectionId))];
      draft.updatedAt = new Date().toISOString();
      const imgs = [...newBlobs].map(([pid, blob]) => ({ id: pid, lectureId: draft.id, blob }));
      await store.saveLecture(draft, imgs, [...removed]);
      newBlobs.clear(); removed.clear(); dirty = false;
      if (showToast) toast('Sparad');
    }
    $('#save').addEventListener('click', async () => {
      if (!draft.startedAt) { toast('Ange när inspelningen började.'); $('#e-start').focus(); return; }
      try { await persist(true); stopLive(); location.hash = `#/f/${encodeURIComponent(draft.id)}`; }
      catch (e) { fail(e, 'Kunde inte spara'); }
    });
    const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    cleanup = () => { stopLive(); clearTimeout(pvTimer); window.removeEventListener('beforeunload', beforeUnload); };
    await renderPhotos();
    await renderPreview();
  }

  /* ---------- tidslinje ---------- */
  function highlight(text, q) {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  }
  function timelineHtml(model, u, opts) {
    const o = opts || {};
    const q = (o.query || '').trim();
    const secs = q ? model.sections.filter((s) => (s.text + ' ' + s.category).toLowerCase().includes(q.toLowerCase())) : model.sections;
    if (!secs.length) return '<p class="muted">Inga avsnitt matchar.</p>';
    return `<ol class="timeline">${secs.map((s) => `<li class="tl ${s.kind === 'anteckning' ? 'note' : ''}" id="${esc(s.id)}">
        <div class="tl-time">${esc(s.clock)}<small>${esc(F.fmtTime(s.start))}</small></div>
        <div class="tl-body">
          <div class="row"><span class="chip ${s.kind === 'anteckning' ? 'note' : ''}">${s.kind === 'anteckning' ? 'Min anteckning' : 'Föreläsaren'}</span><strong>${esc(s.category)}</strong></div>
          <p>${o.compact && s.text.length > 400 ? esc(s.text.slice(0, 400)) + ' …' : highlight(s.text, q)}</p>
          ${s.photos.length ? `<div class="photos">${s.photos.map((p) => `<button type="button" data-photo="${esc(p.id)}"><img src="${u[p.id] || ''}" alt="Bild ${esc(p.name)}" loading="lazy"><span>${esc(p.clock)} · <span class="chip src-${esc(p.source)}">${esc(SRC_LABEL[p.source] || p.source)}</span></span></button>`).join('')}</div>` : ''}
        </div></li>`).join('')}</ol>`;
  }
  function unmatchedHtml(model, u) {
    if (!model.unmatchedPhotos.length) return '';
    return `<div class="warn" style="margin-top:12px"><strong>${model.unmatchedPhotos.length} bilder hamnade utanför inspelningen.</strong> Justera klockan eller starttiden.
      <div class="photos">${model.unmatchedPhotos.map((p) => `<button type="button" data-photo="${esc(p.id)}"><img src="${u[p.id] || ''}" alt="Bild ${esc(p.name)}" loading="lazy"><span>${esc(p.name)} – ${esc(p.reason)}</span></button>`).join('')}</div></div>`;
  }

  /* ---------- lightbox ---------- */
  let lbList = [], lbIdx = 0;
  function openLightbox(list, idx) {
    lbList = list; lbIdx = idx; showLb();
    const d = $('#lightbox'); if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  }
  function showLb() {
    const it = lbList[lbIdx]; if (!it) return;
    $('#lb-img').src = it.url; $('#lb-img').alt = it.caption; $('#lb-cap').textContent = `${it.caption} (${lbIdx + 1}/${lbList.length})`;
    $('#lb-prev').disabled = lbIdx === 0; $('#lb-next').disabled = lbIdx === lbList.length - 1;
  }
  $('#lb-prev').addEventListener('click', () => { if (lbIdx > 0) { lbIdx--; showLb(); } });
  $('#lb-next').addEventListener('click', () => { if (lbIdx < lbList.length - 1) { lbIdx++; showLb(); } });
  $('#lb-close').addEventListener('click', () => $('#lightbox').close());
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') e.currentTarget.close(); });
  $('#lightbox').addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') $('#lb-prev').click(); if (e.key === 'ArrowRight') $('#lb-next').click(); });
  function wireLightbox(root, model, u) {
    const items = [...model.sections.flatMap((s) => s.photos.map((p) => ({ id: p.id, url: u[p.id], caption: `${p.clock} · ${s.category} · ${p.name}` }))),
      ...model.unmatchedPhotos.map((p) => ({ id: p.id, url: u[p.id], caption: `${p.name} (ej placerad)` }))];
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-photo]'); if (!b) return;
      const i = items.findIndex((it) => it.id === b.dataset.photo); if (i >= 0) openLightbox(items, i);
    });
  }

  /* ---------- föreläsningssida ---------- */
  async function viewLecture(id) {
    const rec = await store.get(id);
    if (!rec) throw new Error('Föreläsningen finns inte (raderad eller i en annan webbläsare).');
    document.title = `${rec.title} · Föreläsningar`;
    let model;
    try { model = lectureModel(rec); } catch (e) { model = { sections: [], unmatchedPhotos: [] }; }
    const u = await imageUrls((rec.photos || []).map((p) => p.id));
    const due = F.dueCards(rec.cards, rec.progress).length;
    app.innerHTML = `
      <div class="spread"><div><h1>${esc(rec.title)}</h1><p class="muted" style="margin:0">${esc(fmtDate(rec.startedAt))} · ${model.sections.length} avsnitt · ${(rec.photos || []).length} bilder${rec.offsetSec ? ` · klockjustering ${rec.offsetSec > 0 ? '+' : ''}${rec.offsetSec} s` : ''}</p></div></div>
      <div class="row" style="margin:12px 0">
        <a class="btn" href="#/f/${encodeURIComponent(id)}/kort">Flashcards${due ? ` (${due} att repetera)` : ''}</a>
        <a class="btn ghost" href="#/f/${encodeURIComponent(id)}/kortlista">Redigera kort (${(rec.cards || []).length})</a>
        <a class="btn ghost" href="#/redigera/${encodeURIComponent(id)}">Redigera / justera klocka</a>
        <button class="btn ghost" id="exp" type="button">Exportera</button>
        <button class="btn danger" id="del" type="button">Radera</button>
      </div>
      <input type="search" id="q" placeholder="Sök i föreläsningen …" aria-label="Sök i föreläsningen" style="margin-bottom:12px">
      <div id="tl"></div>`;
    const draw = () => { $('#tl').innerHTML = timelineHtml(model, u, { query: $('#q').value }) + unmatchedHtml(model, u); };
    draw();
    $('#q').addEventListener('input', draw);
    wireLightbox($('#tl'), model, u);
    $('#exp').addEventListener('click', () => exportLectures([rec]).catch((e) => fail(e, 'Export')));
    $('#del').addEventListener('click', async () => {
      if (!confirm(`Radera "${rec.title}" med alla bilder och kort? Det går inte att ångra (exportera först om du vill ha en kopia).`)) return;
      try { await store.remove(id); toast('Raderad'); location.hash = '#/'; } catch (e) { fail(e, 'Radering'); }
    });
  }

  /* ---------- flashcards: plugga ---------- */
  const GRADES = [['again', 'Igen', 'kan inte'], ['hard', 'Svår', ''], ['good', 'Bra', ''], ['easy', 'Lätt', '']];
  function nextLabel(state, g) {
    const s = F.grade(state, g, 0);
    if (s.interval === 0) return '1 min';
    return s.interval === 1 ? '1 dag' : `${s.interval} dagar`;
  }
  async function viewStudy(id, all) {
    const rec = await store.get(id);
    if (!rec) throw new Error('Föreläsningen finns inte.');
    document.title = `Flashcards · ${rec.title}`;
    rec.progress = rec.progress || {};
    const cards = rec.cards || [];
    const queue = (all ? [...cards] : F.dueCards(cards, rec.progress)).sort((a, b) => {
      const sa = rec.progress[a.id], sb = rec.progress[b.id];
      return (sa ? 1 : 0) - (sb ? 1 : 0) || (sa && sb ? sa.due - sb.due : 0);
    });
    const total = queue.length;
    const tally = { again: 0, hard: 0, good: 0, easy: 0 };
    const back = `#/f/${encodeURIComponent(id)}`;
    if (!cards.length) { app.innerHTML = `<div class="panel empty"><h2>Inga kort än</h2><p class="muted">Kort skapas ur avsnitten när du sparar föreläsningen – eller lägg till egna.</p><a class="btn" href="${back}/kortlista">Lägg till kort</a> <a class="btn ghost" href="${back}">Tillbaka</a></div>`; return; }
    let current = null, flipped = false;
    const shell = () => `<div class="study">
      <div class="spread"><a href="${back}">‹ ${esc(rec.title)}</a><span class="muted small" id="count"></span></div>
      <div class="progressbar"><i id="bar" style="width:0%"></i></div><div id="stage"></div></div>`;
    app.innerHTML = shell();
    async function show() {
      const done = total - queue.length;
      $('#bar').style.width = `${total ? Math.round(done / total * 100) : 100}%`;
      $('#count').textContent = `${Math.min(done + 1, total)} / ${total}`;
      current = queue.shift(); flipped = false;
      if (!current) return finish();
      const img = current.photoId ? await imageUrl(current.photoId) : null;
      const st = rec.progress[current.id];
      $('#stage').innerHTML = `
        <div class="flip" id="flip"><div class="flip-inner">
          <div class="face front"><span class="chip">${esc(current.category || 'Kort')}</span><div class="q">${esc(current.question)}</div><span class="muted small" style="margin-top:auto">${st ? `Sett ${st.sett || 0} gånger` : 'Nytt kort'} · tryck mellanslag för att vända</span></div>
          <div class="face back"><span class="chip">${esc(current.category || 'Kort')}</span><div class="muted small">${esc(current.question)}</div><div class="a">${esc(current.answer)}</div>${img ? `<img src="${img}" alt="Bild till kortet" data-big>` : ''}</div>
        </div></div>
        <div id="controls"><button class="btn flipbtn" id="flipbtn" type="button">Vänd kort ⟳</button></div>`;
      $('#flipbtn').addEventListener('click', flip);
      $('#flip').addEventListener('click', (e) => {
        if (e.target.matches('[data-big]')) { openLightbox([{ id: 'x', url: e.target.src, caption: current.category || '' }], 0); return; }
        if (!flipped) flip();
      });
    }
    function flip() {
      if (flipped || !current) return;
      flipped = true; $('#flip').classList.add('flipped');
      const st = rec.progress[current.id];
      $('#controls').innerHTML = `<div class="grades">${GRADES.map(([g, label, sub], i) => `<button class="btn g-${g}" type="button" data-g="${g}">${label}<small>${sub ? sub + ' · ' : ''}${nextLabel(st, g)} · ${i + 1}</small></button>`).join('')}</div>`;
      $$('#controls [data-g]').forEach((b) => b.addEventListener('click', () => rate(b.dataset.g)));
    }
    async function rate(g) {
      if (!flipped || !current) return;
      rec.progress[current.id] = F.grade(rec.progress[current.id], g);
      tally[g]++;
      if (g === 'again') queue.push(current); // tillbaka i samma pass
      try { await store.put(rec); } catch (e) { fail(e, 'Kunde inte spara framsteg'); }
      show();
    }
    function finish() {
      $('#bar').style.width = '100%';
      const left = F.dueCards(cards, rec.progress).length;
      $('#stage').innerHTML = `<div class="panel empty"><h2>${total ? 'Klart för nu!' : 'Inget att repetera just nu'}</h2>
        ${total ? `<div class="stats">${GRADES.map(([g, l]) => `<div class="stat"><b>${tally[g]}</b>${l}</div>`).join('')}</div>` : `<p class="muted">Alla ${cards.length} kort är repeterade. Nästa kort förfaller ${nextDue()}.</p>`}
        <div class="row" style="justify-content:center;margin-top:14px">
          ${left ? `<button class="btn" id="more" type="button">Fortsätt (${left})</button>` : ''}
          <button class="btn ghost" id="all" type="button">Öva alla kort ändå</button>
          <a class="btn ghost" href="${back}">Till föreläsningen</a>
        </div></div>`;
      const more = $('#more'); if (more) more.addEventListener('click', () => { if (location.hash.endsWith('/kort')) route(); else location.hash = `#/f/${encodeURIComponent(id)}/kort`; });
      $('#all').addEventListener('click', () => { if (location.hash.endsWith('/alla')) route(); else location.hash = `#/f/${encodeURIComponent(id)}/kort/alla`; });
    }
    function nextDue() {
      const ds = cards.map((c) => rec.progress[c.id] && rec.progress[c.id].due).filter(Boolean).sort((a, b) => a - b);
      return ds.length ? new Date(ds[0]).toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'snart';
    }
    const onKey = (e) => {
      const t = e.target; if ((t && t.matches && t.matches('input,textarea,select')) || $('#lightbox').open) return;
      if ((e.key === ' ' || e.key === 'Enter') && !flipped) { e.preventDefault(); flip(); }
      else if (flipped && /^[1-4]$/.test(e.key)) rate(GRADES[+e.key - 1][0]);
    };
    document.addEventListener('keydown', onKey);
    cleanup = () => document.removeEventListener('keydown', onKey);
    show();
  }

  /* ---------- flashcards: redigera ---------- */
  async function viewCardList(id) {
    const rec = await store.get(id);
    if (!rec) throw new Error('Föreläsningen finns inte.');
    document.title = `Kort · ${rec.title}`;
    rec.cards = rec.cards || []; rec.progress = rec.progress || {};
    const u = await imageUrls((rec.photos || []).map((p) => p.id));
    const back = `#/f/${encodeURIComponent(id)}`;
    function cardHtml(c) {
      return `<div class="cardedit" data-id="${esc(c.id)}">
        <div class="spread"><span class="chip">${esc(c.category || 'Eget kort')}</span><span class="row">${c.photoId && u[c.photoId] ? `<img src="${u[c.photoId]}" alt="" style="height:40px;border-radius:6px">` : ''}<button class="btn danger" type="button" data-del style="min-height:32px;padding:2px 10px">Ta bort</button></span></div>
        <label class="hint" style="margin:0">Fråga<textarea data-f="question" maxlength="2000">${esc(c.question)}</textarea></label>
        <label class="hint" style="margin:0">Svar<textarea data-f="answer" maxlength="8000">${esc(c.answer)}</textarea></label>
        <label class="hint" style="margin:0">Bild<select data-f="photoId"><option value="">(ingen bild)</option>${(rec.photos || []).map((p) => `<option value="${esc(p.id)}" ${p.id === c.photoId ? 'selected' : ''}>${esc((p.takenAt ? F.fmtClock(p.takenAt) + ' · ' : '') + p.name)}</option>`).join('')}</select></label>
      </div>`;
    }
    function draw() {
      app.innerHTML = `<div class="spread"><div><a href="${back}">‹ ${esc(rec.title)}</a><h1>Redigera kort</h1></div>
          <div class="row"><button class="btn" id="add" type="button">+ Nytt kort</button><button class="btn ghost" id="regen" type="button">Skapa kort för nya avsnitt</button><button class="btn ghost" id="reset" type="button">Nollställ framsteg</button></div></div>
        <p class="hint">Ändringar sparas automatiskt. Ändrade kort skrivs aldrig över när föreläsningen sparas om.</p>
        <div id="cards">${rec.cards.map(cardHtml).join('') || '<p class="muted">Inga kort.</p>'}</div>
        <a class="btn" href="${back}/kort">Plugga korten</a>`;
      $('#add').addEventListener('click', async () => {
        rec.cards.unshift({ id: uid('kort'), question: 'Ny fråga', answer: 'Svar', category: 'Eget kort', photoId: null, generated: false });
        await save(); draw(); const t = $('#cards textarea'); if (t) { t.focus(); t.select(); }
      });
      $('#regen').addEventListener('click', async () => {
        try {
          const have = new Set(rec.cards.map((c) => c.sectionId).filter(Boolean));
          const fresh = F.generateFlashcards(lectureModel(rec).sections).filter((c) => !have.has(c.sectionId));
          rec.cards.push(...fresh); await save(); toast(`${fresh.length} nya kort`); draw();
        } catch (e) { fail(e, 'Kunde inte skapa kort'); }
      });
      $('#reset').addEventListener('click', async () => { if (!confirm('Nollställa all repetitionshistorik för den här föreläsningen?')) return; rec.progress = {}; await save(); toast('Framsteg nollställt'); });
      $('#cards').addEventListener('click', async (e) => {
        if (!e.target.closest('[data-del]')) return;
        const box = e.target.closest('[data-id]'); const cid = box.dataset.id;
        if (!confirm('Ta bort kortet?')) return;
        rec.cards = rec.cards.filter((c) => c.id !== cid); delete rec.progress[cid];
        await save(); box.remove();
      });
      let t;
      $('#cards').addEventListener('input', (e) => {
        const f = e.target.dataset.f; if (!f) return;
        const c = rec.cards.find((x) => x.id === e.target.closest('[data-id]').dataset.id); if (!c) return;
        c[f] = e.target.value || (f === 'photoId' ? null : ''); c.edited = true;
        clearTimeout(t); t = setTimeout(save, 400);
      });
    }
    async function save() {
      for (const c of rec.cards) { if (!String(c.question).trim()) c.question = '(tom fråga)'; }
      try { await store.put(rec); } catch (e) { fail(e, 'Kunde inte spara korten'); }
    }
    draw();
  }

  route();
})();
