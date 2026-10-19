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

- **Ta bara med från (BT-start):** inställning med standard 2026-10-19 (sparas lokalt, går att ändra). Föreläsningar som startar före datumet sparas inte (sidan förklarar varför); bilder vars tid (EXIF/filnamn/filtid) ligger före sållas och listas som "före BT-start"; live-anteckning och transkript med äldre datum avvisas; JSON-import hoppar över äldre föreläsningar och bilder.

## Kort till MedHop (delat kortformat)
Knappen **🎓 Kort till MedHop** (biblioteket = alla föreläsningar, föreläsningssidan = bara den) laddar ner `medhop-forelasningar-<datum>.json` i MedHops deck-format (`_format: medhop-deck-v1`): `{id, title, emoji, color, segments:[{id, title, cards:[{type, front, back, tags}]}]}`, ett segment per föreläsning. Bara text (inga bilder), föreläsningar före "Ta bara med från" hoppas över, personnummer maskeras. Funktion: `toMedHopDeck()` i `forelasningar.js`.

I MedHop (https://medhop.vercel.app): **Importera → Fil → välj filen → Spara kortlek**. Korten hamnar under "Mina kort" i den webbläsaren och repeteras med MedHops SM-2. Importerar du igen blir det en ny lek (ta bort den gamla först; repetitionsstatus följer inte med). Är du inloggad i MedHop följer "Mina kort" med till ditt konto.

BT-material (PLAUD, foton, anteckningar på BT-sidan) går **inte** den här vägen: det synkas automatiskt till den privata MedHop-instansen på Tailscale (`medhop-privat`, MedHop-BT-Synk) och publiceras aldrig.

## Integritet
Inget laddas upp. Sidan har ingen server och en Content-Security-Policy med `connect-src 'none'` spärrar alla nätverksanrop från sidans kod. Data finns bara i webbläsaren där den skapades – exportera för att flytta.

## Tester
```
node forelasningar.test.js
```
Kärnlogiken (`forelasningar.js`) kommer ursprungligen från `plaud-kalender/forelasningar.js` och är utökad här.
