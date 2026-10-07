# Föreläsningar

Fristående webbsida (ren HTML/CSS/JS, inga beroenden) där anteckningar, PLAUD-transkript och bilder hamnar i samma tidslinje – med flashcards per föreläsning i MedHop-stil.

**Live:** https://marcdshark666.github.io/forelasningar/

## Funktioner
- **Ny föreläsning:** titel, starttid (gissas ur PLAUD-filnamnet, t.ex. `2026-10-07 10_00_00 ….srt`), PLAUD-transkript (.srt/.vtt/.txt) och/eller egna anteckningar (`10:15 text`; rader utan tid fördelas jämnt).
- **Live-anteckning:** varje rad får aktuell klocktid när du trycker Enter (autosparas).
- **Bilder:** tid ur EXIF → filnamn (`IMG_20261007_101530`, `PXL_…`, `Screenshot_…`) → filens ändringstid. Källan visas på varje bild. Valfri förminskning till 2000 px.
- **Klockjustering:** reglage, ±-knappar och min/s-fält; förhandsvisningen uppdateras direkt.
- **Föreläsningssida:** tidslinje med kategori, text, bilder där de togs, sök och bildvisare.
- **Bibliotek:** allt i IndexedDB (bilder som blobbar); öppna, radera, exportera/importera som en JSON-fil (bilder base64).
- **Flashcards:** genereras ur avsnitten (lucktext eller nyckelordsfråga, svar = texten, bild om sådan finns), vändkort, Igen/Svår/Bra/Lätt med SM-2 (samma kurva som MedHop). Kort kan redigeras, tas bort och läggas till.

## Integritet
Inget laddas upp. Sidan har ingen server och en Content-Security-Policy med `connect-src 'none'` spärrar alla nätverksanrop från sidans kod. Data finns bara i webbläsaren där den skapades – exportera för att flytta.

## Tester
```
node forelasningar.test.js
```
Kärnlogiken (`forelasningar.js`) kommer ursprungligen från `plaud-kalender/forelasningar.js` och är utökad här.
