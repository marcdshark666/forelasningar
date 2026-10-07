/* Kör: node forelasningar.test.js */
const assert = require('node:assert/strict');
const F = require('./forelasningar.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FEL:', name); throw e; } };

const srt = `1
00:00:02,000 --> 00:00:08,000
Cellen delar sig genom mitos.

2
00:00:09,000 --> 00:00:15,000
DNA kopieras fore nasta celldelning.`;

/* ---- Ursprungliga prover från plaud-kalender ---- */
test('SRT parsas', () => assert.equal(F.parseTranscript(srt).length, 2));
test('syncLecture matchar bilder', () => {
  const lecture = F.syncLecture({ transcript: srt, recordingStartedAt: '2026-10-04T10:00:00', photos: [
    { name: 'bild-1.jpg', takenAt: '2026-10-04T10:00:05' },
    { name: 'bild-2.jpg', takenAt: '2026-10-04T10:00:12' },
  ] });
  assert.equal(lecture.sections[0].photos[0].name, 'bild-1.jpg');
  assert.equal(lecture.sections[1].photos[0].name, 'bild-2.jpg');
  assert.equal(F.generateFlashcards(lecture.sections).length, 2);
});
test('syncLecture kräver SRT', () => assert.throws(() => F.syncLecture({ transcript: 'ingen tidrad', recordingStartedAt: '2026-10-04T10:00:00' }), /SRT/));
test('EXIF-tid ur JPEG', () => {
  const bytes = new Uint8Array(96);
  bytes.set([0xff,0xd8,0xff,0xe1,0,0x5a,0x45,0x78,0x69,0x66,0,0,0x49,0x49,0x2a,0,8,0,0,0], 0);
  bytes.set([1,0,0x69,0x87,4,0,1,0,0,0,26,0,0,0], 20);
  bytes.set([1,0,3,0x90,2,0,20,0,0,0,44,0,0,0], 38);
  bytes.set(Buffer.from('2026:10:04 10:00:05\0'), 56);
  const d = F.exifDateFromJpeg(bytes);
  assert.equal(`${d.getFullYear()}-${d.getHours()}:${d.getSeconds()}`, '2026-10:5');
  assert.equal(F.exifDateFromJpeg(new Uint8Array([1, 2, 3])), null);
});

/* ---- Tid ur filnamn ---- */
const hms = (d) => d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}`;
test('filnamn IMG_', () => assert.equal(hms(F.timeFromFilename('IMG_20261007_101530.jpg')), '2026-10-7 10:15:30'));
test('filnamn PXL_ med millisekunder', () => assert.equal(hms(F.timeFromFilename('PXL_20261007_101530123.jpg')), '2026-10-7 10:15:30'));
test('filnamn Screenshot', () => assert.equal(hms(F.timeFromFilename('Screenshot_2026-10-07-10-15-30.png')), '2026-10-7 10:15:30'));
test('filnamn PLAUD med mellanslag', () => assert.equal(hms(F.timeFromFilename('2026-10-07 09_05_00-Föreläsning.srt')), '2026-10-7 9:5:0'));
test('filnamn utan sekunder', () => assert.equal(hms(F.timeFromFilename('Inspelning 2026-10-07 1415.txt')), '2026-10-7 14:15:0'));
test('filnamn utan tid ger null', () => { assert.equal(F.timeFromFilename('IMG-20261007-WA0001.jpg'), null); assert.equal(F.timeFromFilename('bild.jpg'), null); });
test('photoTime väljer källa', () => {
  const exif = new Date(2026, 9, 7, 10, 0, 0);
  assert.equal(F.photoTime({ exif, name: 'IMG_20261007_111111.jpg' }).source, 'exif');
  assert.equal(F.photoTime({ exif: null, name: 'IMG_20261007_111111.jpg', lastModified: 1 }).source, 'filnamn');
  assert.equal(F.photoTime({ exif: null, name: 'x.jpg', lastModified: Date.UTC(2026, 9, 7) }).source, 'filtid');
  assert.equal(F.photoTime({ name: 'x.jpg' }).source, 'saknas');
});

/* ---- Anteckningar ---- */
const start = new Date(2026, 9, 7, 10, 0, 0);
test('anteckningar med klocktid', () => {
  const cues = F.parseNotes('10:15 Hjärtsvikt NYHA\n10:20:30 Behandling med ACE-hämmare', { start });
  assert.deepEqual(cues.map((c) => c.start), [900, 1230]);
  assert.equal(cues[0].end, 1230);
  assert.equal(cues[0].text, 'Hjärtsvikt NYHA');
});
test('anteckningar utan stämpel fördelas jämnt', () => {
  const cues = F.parseNotes('10:00 Början\nmitt ett\nmitt två\n10:30 Slut', { start });
  assert.deepEqual(cues.map((c) => c.start), [0, 600, 1200, 1800]);
});
test('helt ostämplade anteckningar sprids över längden', () => {
  const cues = F.parseNotes('a rad\nb rad\nc rad', { start, durationSec: 300 });
  assert.deepEqual(cues.map((c) => c.start), [0, 100, 200]);
});
test('PLAUD-txt med relativa stämplar och talare', () => {
  const cues = F.parseNotes('00:00:05 Talare 1\nVälkomna till föreläsningen\n00:01:10 Speaker 2\nTack så mycket', { start });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 5);
  assert.equal(cues[1].start, 70);
  assert.equal(cues[1].text, 'Tack så mycket');
});
test('klocktid efter midnatt', () => {
  const cues = F.parseNotes('00:10 sent', { start: new Date(2026, 9, 7, 23, 50, 0) });
  assert.equal(cues[0].start, 1200);
});

/* ---- Klockförskjutning ---- */
test('offset flyttar bilden till rätt avsnitt', () => {
  const photos = [{ id: 'p1', name: 'a.jpg', takenAt: new Date(2026, 9, 7, 10, 0, 5) }];
  const utan = F.buildLecture({ transcript: srt, recordingStartedAt: start, photos, chunkSec: 0 });
  assert.equal(utan.sections[0].photos.length, 1);
  const med = F.buildLecture({ transcript: srt, recordingStartedAt: start, photos, chunkSec: 0, offsetSec: 7 });
  assert.equal(med.sections[1].photos[0].id, 'p1');
  assert.equal(med.sections[1].photos[0].second, 12);
});
test('bild långt utanför inspelningen blir omatchad', () => {
  const photos = [{ id: 'p', name: 'b.jpg', takenAt: new Date(2026, 9, 7, 12, 0, 0) }, { id: 'q', name: 'c.jpg', takenAt: null }];
  const l = F.buildLecture({ transcript: srt, recordingStartedAt: start, photos });
  assert.equal(l.unmatchedPhotos.length, 2);
  const fix = F.buildLecture({ transcript: srt, recordingStartedAt: start, photos: photos.slice(0, 1), offsetSec: -7200 + 3 });
  assert.equal(fix.unmatchedPhotos.length, 0);
});

/* ---- Bygg / gruppera / kort ---- */
test('transkript grupperas till avsnitt', () => {
  const g = F.groupCues(F.parseTranscript(srt), 60);
  assert.equal(g.length, 1);
  assert.match(g[0].text, /mitos.*DNA/);
});
test('transkript + anteckningar blandas i tidsordning', () => {
  const l = F.buildLecture({ transcript: srt, notes: '10:00:10 Viktigt: mitos ger två dotterceller', recordingStartedAt: start, chunkSec: 0 });
  assert.deepEqual(l.sections.map((s) => s.kind), ['tal', 'tal', 'anteckning']);
  assert.equal(l.sections[2].clock, '10:00');
});
test('tomt underlag ger fel', () => {
  assert.throws(() => F.buildLecture({ recordingStartedAt: start }), /transkript/);
  assert.throws(() => F.buildLecture({ notes: 'x', recordingStartedAt: 'nej' }), /inspelningen/);
});
test('flashcards har lucka och bild', () => {
  const l = F.buildLecture({ notes: '10:01 Furosemid är ett loopdiuretikum', recordingStartedAt: start,
    photos: [{ id: 'bild1', name: 'x.jpg', takenAt: new Date(2026, 9, 7, 10, 1, 30) }] });
  const [card] = F.generateFlashcards(l.sections);
  assert.match(card.question, /_____/);
  assert.equal(card.photoId, 'bild1');
  assert.equal(card.answer, 'Furosemid är ett loopdiuretikum');
});

/* ---- SM-2 ---- */
test('SM-2 som MedHop', () => {
  const t = 1_000_000;
  let s = F.grade(null, 'good', t);
  assert.equal(s.interval, 1); assert.equal(s.reps, 1);
  s = F.grade(s, 'good', t); assert.equal(s.interval, 6);
  s = F.grade(s, 'again', t); assert.equal(s.reps, 0); assert.equal(s.lapses, 1); assert.equal(s.due, t + 60000);
  assert.equal(s.sett, 3);
  assert.throws(() => F.grade(s, 'konstigt'), /betyg/);
  const due = F.dueCards([{ id: 'a' }, { id: 'b' }], { a: { due: t + 1 } }, t);
  assert.deepEqual(due.map((c) => c.id), ['b']);
});
test('formattering', () => {
  assert.equal(F.fmtTime(75), '01:15');
  assert.equal(F.fmtTime(3725), '1:02:05');
  assert.equal(F.toLocalInput(start), '2026-10-07T10:00:00');
});


/* ---- "Ta bara med från" (BT-start) ---- */
test('standardgräns är 2026-10-19 lokal midnatt', () => {
  assert.equal(F.DEFAULT_CUTOFF, '2026-10-19');
  const d = F.cutoffDate();
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 9, 19, 0]);
  assert.equal(F.cutoffDate('skräp').getDate(), 19);
  assert.equal(F.cutoffDate('2026-02-31').getDate(), 19); // ogiltigt datum → standard
});
test('isBeforeCutoff', () => {
  assert.equal(F.isBeforeCutoff(new Date(2026, 9, 18, 23, 59, 59)), true);
  assert.equal(F.isBeforeCutoff(new Date(2026, 9, 19, 0, 0, 0)), false);
  assert.equal(F.isBeforeCutoff(null), false);
  assert.equal(F.isBeforeCutoff(new Date(2026, 9, 7), '2026-10-01'), false);
});
test('föreläsning före BT-start avvisas med förklaring', () => {
  assert.match(F.lectureCutoffError(new Date(2026, 9, 7, 10)), /före BT-start/);
  assert.equal(F.lectureCutoffError(new Date(2026, 9, 20, 10)), null);
  assert.equal(F.lectureCutoffError(new Date(2026, 9, 7, 10), '2026-10-01'), null);
});
test('bilder före BT-start sållas oavsett tidskälla', () => {
  const ph = [
    { id: 'a', ...F.photoTime({ exif: new Date(2026, 9, 18, 9) }) },
    { id: 'b', ...F.photoTime({ name: 'IMG_20261015_101530.jpg' }) },
    { id: 'c', ...F.photoTime({ name: 'x.jpg', lastModified: new Date(2026, 9, 1).getTime() }) },
    { id: 'd', ...F.photoTime({ name: 'PXL_20261020_080000000.jpg' }) },
    { id: 'e', name: 'utan-tid.jpg', takenAt: null, source: 'saknas' },
  ];
  const { kept, rejected } = F.filterPhotosByCutoff(ph);
  assert.deepEqual(rejected.map((p) => p.id), ['a', 'b', 'c']);
  assert.ok(rejected.every((p) => p.reason === 'före BT-start'));
  assert.deepEqual(kept.map((p) => p.id), ['d', 'e']);
});
test('import sållar gamla föreläsningar och bilder', () => {
  const { accepted, rejected } = F.filterImportByCutoff([
    { id: 'gammal', title: 'Gammal', startedAt: new Date(2026, 9, 7, 10).toISOString(), photos: [] },
    { id: 'ny', title: 'Ny', startedAt: new Date(2026, 9, 20, 10).toISOString(),
      photos: [{ id: 'p1', takenAt: new Date(2026, 9, 20, 10, 5).toISOString() }, { id: 'p0', takenAt: new Date(2026, 9, 10).toISOString() }],
      images: [{ id: 'p1' }, { id: 'p0' }] },
  ]);
  assert.deepEqual(rejected.map((r) => r.id), ['gammal']);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].photos.map((p) => p.id), ['p1']);
  assert.deepEqual(accepted[0].images.map((p) => p.id), ['p1']);
  assert.equal(accepted[0].droppedPhotos, 1);
});

console.log(`forelasningar: ${n} prover gröna`);
