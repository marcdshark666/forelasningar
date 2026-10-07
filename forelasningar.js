/* Föreläsningar – kärnlogik (ren JS, körs både i webbläsaren och i node).
   Ursprung: plaud-kalender/forelasningar.js (SRT/VTT, EXIF, matchning).
   Utökad med: anteckningar med klocktid, tid ur filnamn, klockförskjutning,
   avsnittsgruppering, flashcards och SM-2 (samma kurva som MedHop). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Forelasningar = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');

  /* mm:ss (eller h:mm:ss) räknat från inspelningens start */
  function fmtTime(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  }
  /* Klocktid HH:MM(:SS) för ett datum */
  function fmtClock(date, withSeconds) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? ':' + pad(d.getSeconds()) : ''}`;
  }
  /* Värde för <input type="datetime-local" step="1"> i lokal tid */
  function toLocalInput(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /* ---------- SRT / VTT ---------- */
  function parseStamp(value) {
    const m = String(value || '').trim().match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?/);
    if (!m) return null;
    return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +(m[4].padEnd(3, '0')) / 1000 : 0);
  }
  function parseTranscript(text) {
    const rows = String(text || '').replace(/\r/g, '').split('\n'), cues = []; let current = null;
    for (const raw of rows) {
      const line = raw.trim();
      if (!line || /^WEBVTT/i.test(line) || /^NOTE\b/i.test(line) || /^\d+$/.test(line)) continue;
      if (line.includes('-->')) {
        const [start, end] = line.split('-->').map(parseStamp);
        if (start !== null && end !== null) { current = { start, end, text: '' }; cues.push(current); }
      } else if (current) current.text += `${current.text ? ' ' : ''}${line.replace(/<[^>]*>/g, '')}`;
    }
    return cues.filter((cue) => cue.text);
  }

  /* ---------- Fria anteckningar / PLAUD-.txt ----------
     Rader kan börja med en tidsstämpel:
       "10:15 text"      → klocktid (HH:MM)
       "10:15:32 text"   → klocktid (HH:MM:SS)
       "00:01:23 text"   → relativ tid om första stämpeln börjar på 00: (PLAUD-export)
     Rader utan stämpel fördelas jämnt mellan närmaste kända tider.
     En stämpel utan text (eller bara "Talare 1") tar nästa rader som sin text. */
  const STAMP_LINE = /^\s*\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*(?:[-–—:|]\s*)?(.*)$/;
  const SPEAKER_ONLY = /^(speaker|talare|deltagare|person)\s*\d*\s*:?$/i;
  function parseNotes(text, opts) {
    const o = opts || {};
    const start = o.start != null ? new Date(o.start) : null;
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let relative = o.relative;
    const items = [];
    let pending = null; // stämpel som väntar på text
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(STAMP_LINE);
      if (m && +m[2] < 60 && (m[3] == null || +m[3] < 60)) {
        const h = +m[1], mi = +m[2], se = m[3] != null ? +m[3] : 0;
        if (relative == null) relative = m[3] != null && h === 0;
        let second;
        if (relative) second = h * 3600 + mi * 60 + se;
        else if (start && !Number.isNaN(start.getTime())) {
          const at = new Date(start); at.setHours(h, mi, se, 0);
          second = (at.getTime() - start.getTime()) / 1000;
          if (second < -12 * 3600) second += 86400; // passerat midnatt
        } else second = h * 3600 + mi * 60 + se;
        const rest = m[4].trim();
        const item = { second, text: SPEAKER_ONLY.test(rest) ? '' : rest, stamped: true };
        items.push(item);
        pending = item.text ? null : item;
      } else if (pending) {
        pending.text = line; pending = null;
      } else items.push({ second: null, text: line, stamped: false });
    }
    const notes = items.filter((it) => it.text);
    // fördela rader utan tid
    const duration = Number(o.durationSec) > 0 ? Number(o.durationSec) : null;
    for (let i = 0; i < notes.length;) {
      if (notes[i].second != null) { i++; continue; }
      let j = i; while (j < notes.length && notes[j].second == null) j++;
      const prev = i > 0 ? notes[i - 1].second : 0;
      const next = j < notes.length ? notes[j].second : (duration != null && duration > prev ? duration : prev + 60 * (j - i + (i > 0 ? 1 : 0)));
      const count = j - i, step = (next - prev) / (count + (i > 0 ? 1 : 0));
      for (let k = 0; k < count; k++) notes[i + k].second = prev + step * (k + (i > 0 ? 1 : 0));
      i = j;
    }
    const cues = notes
      .map((n) => ({ start: Math.round(n.second * 10) / 10, text: n.text, stamped: n.stamped }))
      .sort((a, b) => a.start - b.start);
    cues.forEach((c, i) => {
      const nextStart = i + 1 < cues.length ? cues[i + 1].start : null;
      c.end = nextStart != null && nextStart > c.start ? nextStart : c.start + 60;
    });
    return cues;
  }

  /* Slå ihop korta transkriptrader till avsnitt på ~chunkSec sekunder */
  function groupCues(cues, chunkSec) {
    const limit = Number(chunkSec) || 0;
    if (limit <= 0) return cues.map((c) => ({ ...c }));
    const out = [];
    for (const cue of cues) {
      const last = out[out.length - 1];
      if (last && cue.end - last.start <= limit) { last.end = Math.max(last.end, cue.end); last.text += ' ' + cue.text; }
      else out.push({ ...cue });
    }
    return out;
  }

  /* ---------- Tid ur bild/fil ---------- */
  function exifDateFromJpeg(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const str = (at, len) => String.fromCharCode(...data.slice(at, at + len));
    const u16 = (at, le) => le ? data[at] | (data[at + 1] << 8) : (data[at] << 8) | data[at + 1];
    const u32 = (at, le) => le ? (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0 : ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
    if (data[0] !== 0xff || data[1] !== 0xd8) return null;
    for (let pos = 2; pos + 10 < data.length;) {
      if (data[pos] !== 0xff) { pos++; continue; }
      const marker = data[pos + 1]; if (marker === 0xda || marker === 0xd9) break;
      const length = (data[pos + 2] << 8) | data[pos + 3];
      if (marker === 0xe1 && str(pos + 4, 6) === 'Exif\0\0') {
        try {
          const base = pos + 10, le = str(base, 2) === 'II'; if (!le && str(base, 2) !== 'MM') return null;
          const readIfd = (offset) => { const found = {}, count = u16(base + offset, le); for (let i = 0; i < count && i < 500; i++) { const at = base + offset + 2 + i * 12, tag = u16(at, le), type = u16(at + 2, le); if ((tag === 0x9003 || tag === 0x0132 || tag === 0x8769) && type) found[tag] = { count: u32(at + 4, le), value: u32(at + 8, le) }; } return found; };
          const ifd = readIfd(u32(base + 4, le)), exif = ifd[0x8769] ? readIfd(ifd[0x8769].value) : {}, item = exif[0x9003] || ifd[0x0132];
          if (!item) return null;
          const match = str(base + item.value, Math.min(item.count, 32)).match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
          return match ? new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : null;
        } catch (e) { return null; }
      }
      pos += 2 + (length || 2);
    }
    return null;
  }

  /* IMG_20261007_101530.jpg, PXL_20261007_101530123.jpg, 20261007_101530.jpg,
     Screenshot_2026-10-07-10-15-30.png, "2026-10-07 10.15.30.jpg",
     PLAUD "2026-10-07 10_15_30.srt", WhatsApp "IMG-20261007-WA0001" (bara datum → null). */
  function timeFromFilename(name) {
    const s = String(name || '');
    const m = s.match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[ T_\-.]{0,3}([01]\d|2[0-3])[-_.:h]?([0-5]\d)(?:[-_.:m]?([0-5]\d))?/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /* Välj bästa tidskälla: EXIF > filnamn > filens ändringstid */
  function photoTime({ exif, name, lastModified }) {
    if (exif instanceof Date && !Number.isNaN(exif.getTime())) return { takenAt: exif, source: 'exif' };
    const fromName = timeFromFilename(name);
    if (fromName) return { takenAt: fromName, source: 'filnamn' };
    if (lastModified) { const d = new Date(lastModified); if (!Number.isNaN(d.getTime())) return { takenAt: d, source: 'filtid' }; }
    return { takenAt: null, source: 'saknas' };
  }

  /* ---------- Kategorier / nyckelord ---------- */
  const STOP = new Set(('detta denna dessa också säger kommer skulle inte från vara eller efter innan under över bara mycket några någon något många alla allt andra annan annat där därför här hela sedan till varför vilken vilket vilka själv samma sådan sådana kanske ganska väldigt liksom alltså egentligen faktiskt nämligen dock även också mellan genom utan emot mot inom första andra tredje sätt gång gånger ofta alltid aldrig blir blev bliva finns fanns hade har haft göra gjorde gör kunna kan kunde måste ska skall vill ville borde sina sitt sin deras hennes hans vårt våra vara varit väl nog just jättebra okej ja nej välkomna välkommen idag imorgon igår pratar prata pratade säga sagt tänka tänker viktigt ihåg används eftersom tycker titta tittar exempel this that with from have will they there their what when which would about these those then than were been also into speaker talare').split(' '));
  function keywordsOf(text) {
    const words = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) || [];
    const counts = new Map();
    words.forEach((w, i) => {
      const k = w.toLowerCase(); if (STOP.has(k) || /^\d+$/.test(k)) return;
      const c = counts.get(k) || { word: w, n: 0, first: i };
      c.n += 1 + Math.min(k.length, 16) / 10 + (/^\p{Lu}/u.test(w) && i > 0 ? 0.5 : 0); counts.set(k, c);
    });
    return [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((c) => c.word);
  }
  function categoryFor(text, index) {
    const w = keywordsOf(text)[0];
    return w ? w[0].toUpperCase() + w.slice(1) : `Avsnitt ${index + 1}`;
  }

  /* ---------- Bygg föreläsningen ---------- */
  function buildLecture(input) {
    const { transcript = '', notes = '', photos = [], recordingStartedAt, title = 'Föreläsning' } = input || {};
    const offsetSec = Number(input && input.offsetSec) || 0;
    const chunkSec = input && input.chunkSec != null ? Number(input.chunkSec) : 60;
    const start = new Date(recordingStartedAt);
    if (Number.isNaN(start.getTime())) throw new Error('Ange när inspelningen började.');
    let spoken = [];
    if (String(transcript).trim()) {
      spoken = String(transcript).includes('-->')
        ? groupCues(parseTranscript(transcript), chunkSec)
        : groupCues(parseNotes(transcript, { start }), chunkSec);
      if (!spoken.length) throw new Error('Transkriptet gick inte att läsa (förväntar SRT, VTT eller text med tidsstämplar).');
    }
    const spokenEnd = spoken.length ? spoken[spoken.length - 1].end : null;
    const noteCues = String(notes).trim() ? parseNotes(notes, { start, durationSec: spokenEnd }) : [];
    if (!spoken.length && !noteCues.length) throw new Error('Lägg till ett transkript eller skriv anteckningar.');
    const sections = [
      ...spoken.map((c) => ({ ...c, kind: 'tal' })),
      ...noteCues.map((c) => ({ ...c, kind: 'anteckning' })),
    ].sort((a, b) => a.start - b.start || (a.kind === 'tal' ? -1 : 1))
      .map((c, i) => ({ id: `avsnitt-${i + 1}`, kind: c.kind, start: c.start, end: c.end, text: c.text,
        category: categoryFor(c.text, i), clock: fmtClock(new Date(start.getTime() + c.start * 1000)), photos: [] }));
    const lastEnd = Math.max(...sections.map((s) => s.end));
    const unmatchedPhotos = [];
    for (const photo of photos) {
      const takenAt = photo.takenAt instanceof Date ? photo.takenAt : new Date(photo.takenAt);
      if (photo.takenAt == null || Number.isNaN(takenAt.getTime())) { unmatchedPhotos.push({ ...photo, reason: 'Bilden saknar läsbar tid.' }); continue; }
      const second = (takenAt.getTime() + offsetSec * 1000 - start.getTime()) / 1000;
      if (second < -60 || second > lastEnd + 60) { unmatchedPhotos.push({ ...photo, second, reason: second < 0 ? 'Tagen före inspelningen.' : 'Tagen efter inspelningen.' }); continue; }
      let target = sections[0];
      for (const s of sections) if (s.start <= second) target = s;
      target.photos.push({ ...photo, second, clock: fmtClock(new Date(start.getTime() + second * 1000), true) });
    }
    sections.forEach((s) => s.photos.sort((a, b) => a.second - b.second));
    return { title, recordingStartedAt: start.toISOString(), offsetSec, sections, unmatchedPhotos };
  }

  /* Bakåtkompatibelt namn från plaud-kalender */
  function syncLecture(input) {
    if (!String(input && input.transcript || '').includes('-->')) throw new Error('Transkriptet saknar SRT/VTT-tidsrader.');
    return buildLecture({ chunkSec: 0, ...input });
  }

  /* ---------- Flashcards ---------- */
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function cardFromSection(section, index) {
    const text = String(section.text || '').trim();
    if (text.length < 12) return null;
    const kw = keywordsOf(text)[0];
    const photoId = section.photos && section.photos[0] ? section.photos[0].id : null;
    let question;
    const re = kw ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(kw)}(?![\\p{L}\\p{N}])`, 'u') : null;
    if (kw && text.length <= 220 && re.test(text)) question = `Fyll i luckan (${section.clock}): ${text.replace(re, '$1_____')}`;
    else if (kw) question = `${section.kind === 'anteckning' ? 'Vad antecknade du' : 'Vad sades'} om «${kw}» kring ${section.clock}?`;
    else question = `Vad gick ni igenom kring ${section.clock}?`;
    return { id: `kort-${section.id}`, sectionId: section.id, question, answer: text, category: section.category, photoId, generated: true };
  }
  function generateFlashcards(sections) {
    return (sections || []).map(cardFromSection).filter(Boolean);
  }

  /* ---------- SM-2 (samma kurva som MedHop) ---------- */
  function newState() { return { ef: 2.5, interval: 0, reps: 0, due: 0, lapses: 0, last: 0, sett: 0 }; }
  function grade(state, quality, now) {
    const q = { again: 2, hard: 3, good: 4, easy: 5 }[quality];
    if (!q) throw new Error('Okänt betyg: ' + quality);
    const t = now == null ? Date.now() : now;
    const s = { ...newState(), ...(state || {}) };
    if (q < 3) { s.reps = 0; s.interval = 0; s.lapses += 1; s.due = t + 60 * 1000; }
    else {
      if (s.reps === 0) s.interval = 1;
      else if (s.reps === 1) s.interval = q === 3 ? 4 : 6;
      else s.interval = Math.round(s.interval * s.ef * (q === 3 ? 0.8 : 1) * (q === 5 ? 1.25 : 1));
      s.interval = Math.max(1, s.interval);
      s.reps += 1;
      s.ef = Math.min(3.2, Math.max(1.3, s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))));
      s.due = t + s.interval * DAY;
    }
    s.last = t; s.sett += 1;
    return s;
  }
  function dueCards(cards, progress, now) {
    const t = now == null ? Date.now() : now;
    return (cards || []).filter((c) => { const s = progress && progress[c.id]; return !s || s.due <= t; });
  }


  /* ---------- "Ta bara med från" (BT-start 2026-10-19) ----------
     Allt med tid före gränsdatumet (lokal midnatt) sållas bort. */
  const DEFAULT_CUTOFF = '2026-10-19';
  function cutoffDate(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    return d && !Number.isNaN(d.getTime()) && d.getMonth() === +m[2] - 1 ? d : cutoffDate(DEFAULT_CUTOFF);
  }
  function isBeforeCutoff(date, cutoff) {
    if (date == null) return false;
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return false;
    return d.getTime() < cutoffDate(cutoff).getTime();
  }
  function cutoffLabel(cutoff) { return cutoffDate(cutoff).toLocaleDateString('sv-SE'); }
  /* null = ok, annars förklaring på svenska */
  function lectureCutoffError(startedAt, cutoff) {
    const d = new Date(startedAt);
    if (startedAt == null || Number.isNaN(d.getTime())) return null;
    return isBeforeCutoff(d, cutoff)
      ? `Inspelningen började ${d.toLocaleDateString('sv-SE')}, före BT-start ${cutoffLabel(cutoff)}. Sidan tar bara med föreläsningar från och med ${cutoffLabel(cutoff)} (ändra under "Ta bara med från").`
      : null;
  }
  function filterPhotosByCutoff(photos, cutoff) {
    const kept = [], rejected = [];
    for (const p of photos || []) (isBeforeCutoff(p.takenAt, cutoff) ? rejected.push({ ...p, reason: 'före BT-start' }) : kept.push(p));
    return { kept, rejected };
  }
  /* Import: släpp föreläsningar före gränsen, sålla äldre bilder i resten */
  function filterImportByCutoff(lectures, cutoff) {
    const accepted = [], rejected = [];
    for (const l of lectures || []) {
      const err = l && lectureCutoffError(l.startedAt, cutoff);
      if (err) { rejected.push({ id: l.id, title: l.title, reason: err }); continue; }
      const { kept, rejected: old } = filterPhotosByCutoff(l && l.photos, cutoff);
      const drop = new Set(old.map((p) => p.id));
      accepted.push({ ...l, photos: kept, images: (l.images || []).filter((im) => !drop.has(im.id)), droppedPhotos: old.length });
    }
    return { accepted, rejected };
  }

  return { parseStamp, parseTranscript, parseNotes, groupCues, exifDateFromJpeg, timeFromFilename, photoTime,
    keywordsOf, buildLecture, DEFAULT_CUTOFF, cutoffDate, isBeforeCutoff, cutoffLabel, lectureCutoffError, filterPhotosByCutoff, filterImportByCutoff, syncLecture, generateFlashcards, grade, dueCards, newState, fmtTime, fmtClock, toLocalInput };
});
