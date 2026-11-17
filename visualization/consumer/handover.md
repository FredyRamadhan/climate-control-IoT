Done. The dashboard now matches your Penpot design.

**What changed** — `dashboard/index.html` (full rewrite, 39 KB → 24 KB)

| Penpot design | App |
|---|---|
| White bg, `#F4F4F4` cards, radius 10, Source Sans Pro | Same tokens, Source Sans 3 vendored locally (`dashboard/fonts/`) |
| `24px` bold section titles, `18px` labels, `48px` bold values, `36px` units | Same scale |
| Navbar "Auto-Climate Control" | Same, + a small live-status dot (connection / active override) |
| A/C Unit dan Lampu: photo 464px + 4 cards 159px | `AC photo.png` copied to `dashboard/ac-photo.png`, cards: Temperatur · Fan Speed · A/C · Lampu |
| Data Sensor / Cuaca Surakarta side by side, cards 185px | Temperatur · Kelembapan · Ruangan Dihuni / Temperatur · Kelembapan · Hujan |
| Kontrol Override Manual: 4 cards 287px + Atur / 5 Detik / Lepas (387px) | Temp (− / +), Fan (tap to cycle), A/C (tap to toggle), Lampu placeholder (as requested) |

**Removed** (per "drop extras"): charts + Chart.js, status pills, API-base bar, ACK panel, command log, raw payload viewers, raw-IR mode.

**Functionality kept**
- Polls `/health`, `/transmit/latest`, `/weather/latest` every 3 s; values auto-prefill the controls unless you're mid-edit.
- **Atur** → `POST /command` override with temp/fan/A/C + duration; **5 Detik** cycles 5 s → 30 s → 1 m → 5 m → sampai lepas; **Lepas** → release. Feedback line reports applied / rejected / ACK-timeout.

**Verified**
- Rendered headlessly at 1440 px: card widths measured 159 / 185 / 287 / 387 px — exactly the design's geometry; text stays inside all cards; layout stacks cleanly at 900 px and 520 px.
- Functional test with a mocked API and jsdom: live values, K→C weather conversion, rain detection, control prefill, all three controls, override payload, release, timeout and offline states — all pass.
- Stale "vendored Chart.js" comment in `main.py` updated.

Two notes: the old page is backed up at `/tmp/opencode/index.old.html`, and `dashboard/vendor/chart.umd.min.js` (208 KB) is now unused — say the word and I'll delete it.