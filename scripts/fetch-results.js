/**
 * fetch-results.js
 * Run with: npm run fetch
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Event config ─────────────────────────────────────────────────────────────

const EVENTS = [
  {
    year: 2025,
    id: '335839',
    key: 'e69ef4c633d857695625848f986143c4',
    listPrefix: 'Result Lists - 2022',
    startTimes: {
      'Marathon':       '09:00:00',
      'Marathon Relay': '09:00:00',
      'Half Marathon':  '10:30:00',
      '6 Mile':         '12:30:00',
    },
  },
  {
    year: 2026,
    id: '393565',
    key: 'd830b4f928aa0a92d232b6fd862d0089',
    listPrefix: 'Result Lists - 2026',
    startTimes: {
      'Marathon':       '09:00:00',
      'Marathon Relay': '09:00:00',
      'Half Marathon':  '11:00:00',
      '6 Mile':         '13:30:00',
    },
  },
];

const RACES = ['Marathon', 'Marathon Relay', 'Half Marathon', '6 Mile'];

// ─── Field maps ───────────────────────────────────────────────────────────────
//
// Confirmed against raw row samples and Fields API responses.
// Structure is identical between 2025 and 2026 for every race.
//
// Marathon:       0:bib 1:id 2:name 3:gender 4:o/a 5:agegroup 6:club
//                 7:10k 8:20k 9:hm 10:30k 11:40k 12:chip 13:gun ...
//
// Half Marathon:  0:bib 1:id 2:name 3:gender 4:o/a 5:agegroup 6:club
//                 7:3k 8:9k 9:17k 10:19k 11:chip 12:gun ...
//
// 6 Mile:         0:bib 1:id 2:name 3:gender 4:o/a 5:agegroup 6:club
//                 7:chip 8:gun ...
//
// Marathon Relay: 0:bib 1:id 2:o/a_rank 3:team_name 4:club
//                 5:10k 6:20k 7:hm 8:30k 9:40k 10:chip 11:gun ...

const FIELD_MAP = {
  'Marathon': {
    bib: 0, name: 2, gender: 3, club: 6,
    chip: 12, gun: 13,
    finishKm: 42.195,
    splits: [
      { km: 10,      idx: 7  },
      { km: 20,      idx: 8  },
      { km: 21.0975, idx: 9  },
      { km: 30,      idx: 10 },
      { km: 40,      idx: 11 },
    ],
  },
  'Half Marathon': {
    bib: 0, name: 2, gender: 3, club: 6,
    chip: 11, gun: 12,
    finishKm: 21.0975,
    splits: [
      { km: 3,  idx: 7  },
      { km: 9,  idx: 8  },
      { km: 17, idx: 9  },
      { km: 19, idx: 10 },
    ],
  },
  '6 Mile': {
    bib: 0, name: 2, gender: 3, club: 6,
    chip: 7, gun: 8,
    finishKm: 9.656,
    splits: [],
  },
  'Marathon Relay': {
    bib: 0, name: 3, gender: null, club: 4,
    chip: 10, gun: 11,
    finishKm: 42.195,
    splits: [
      { km: 10,      idx: 5 },
      { km: 20,      idx: 6 },
      { km: 21.0975, idx: 7 },
      { km: 30,      idx: 8 },
      { km: 40,      idx: 9 },
    ],
  },
};

// ─── Validity bounds ──────────────────────────────────────────────────────────
//
// Rows outside these bounds are likely DNFs, walkers who abandoned early,
// or bad chip reads — they produce implausible positions on the course.

const BOUNDS = {
  'Marathon':       { minChipS: 60 * 60,      maxOffsetS: 30 * 60 }, // min 1h, max 30min wave
  'Marathon Relay': { minChipS: 60 * 60,      maxOffsetS: 30 * 60 },
  'Half Marathon':  { minChipS: 30 * 60,      maxOffsetS: 30 * 60 }, // min 30min
  '6 Mile':         { minChipS: 20 * 60,      maxOffsetS: 30 * 60 }, // min 20min
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

function parseTimeToSeconds(str) {
  if (!str) return null;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function secondsToHMS(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function calcClockFinish(startTimeStr, gunTimeStr) {
  const startSecs = parseTimeToSeconds(startTimeStr);
  const gunSecs   = parseTimeToSeconds(gunTimeStr);
  if (startSecs === null || gunSecs === null) return null;
  return secondsToHMS(startSecs + gunSecs);
}

function clockToMinutes(clockStr) {
  const secs = parseTimeToSeconds(clockStr);
  return secs !== null ? secs / 60 : null;
}

function canonicalRace(listName) {
  const n = listName.toLowerCase();
  if (n.includes('relay'))    return 'Marathon Relay';
  if (n.includes('half'))     return 'Half Marathon';
  if (n.includes('marathon')) return 'Marathon';
  if (n.includes('6 mile') || n.includes('6mile') || n.includes('six mile')) return '6 Mile';
  return listName;
}

function rowVal(row, idx) {
  if (idx === null || idx === undefined) return null;
  const v = row[idx];
  return (v === '' || v === null || v === undefined) ? null : v;
}

// ─── Row parser ───────────────────────────────────────────────────────────────

function parseRows(raw, listName, year, startTimes) {
  const dataObj    = raw.data ?? {};
  const firstValue = Object.values(dataObj)[0] ?? [];
  const rows = Array.isArray(firstValue[0]) ? firstValue : Object.values(dataObj);

  const race      = canonicalRace(listName);
  const startTime = startTimes[race] ?? null;
  const fm        = FIELD_MAP[race];
  const bounds    = BOUNDS[race];

  if (!fm) {
    console.warn(`  ⚠  No field map for race "${race}" — skipping`);
    return [];
  }
  if (!startTime) {
    console.warn(`  ⚠  No start time for race "${race}" — clock_finish will be null`);
  }

  const startSecs = parseTimeToSeconds(startTime);
  let discarded = 0;

  const results = rows
    .filter(row => Array.isArray(row))
    .map(row => {
      const gunTime  = rowVal(row, fm.gun);
      const chipTime = rowVal(row, fm.chip);
      const gunSecs  = parseTimeToSeconds(gunTime);
      const chipSecs = parseTimeToSeconds(chipTime);

      const clockFinish  = startTime ? calcClockFinish(startTime, gunTime) : null;
      const finishMinute = clockToMinutes(clockFinish);

      // ── Validity check ───────────────────────────────────────────────────
      if (gunSecs === null || chipSecs === null) {
        discarded++;
        return null;
      }

      const offset = gunSecs - chipSecs;

      if (
        chipSecs < bounds.minChipS    ||  // implausibly fast (DNF / bad read)
        offset   < 0                  ||  // chip faster than gun (impossible)
        offset   > bounds.maxOffsetS      // implausibly large wave delay
      ) {
        discarded++;
        return null;
      }

      // ── Build split anchors ──────────────────────────────────────────────
      //
      // Split times are chip-elapsed (from when the runner crossed the mat).
      // Convert to gun-elapsed by adding the personal offset:
      //   split_gun_elapsed = split_chip_elapsed + offset
      //
      // Start anchor: runner crosses mat at `offset` seconds after gun.
      // Finish anchor: gun_time is gun-elapsed by definition.

      const splitAnchors = [];

      // Start anchor
      splitAnchors.push({
        km:         0,
        elapsed_s:  offset,
        clock_time: secondsToHMS(startSecs + offset),
      });

      // Intermediate splits
      for (const sp of fm.splits) {
        const splitChipElapsed = parseTimeToSeconds(rowVal(row, sp.idx));
        if (splitChipElapsed !== null && splitChipElapsed > 0) {
          const elapsed_s = splitChipElapsed + offset;
          splitAnchors.push({
            km:         sp.km,
            elapsed_s,
            clock_time: secondsToHMS(startSecs + elapsed_s),
          });
        }
      }

      // Finish anchor
      splitAnchors.push({
        km:         fm.finishKm,
        elapsed_s:  gunSecs,
        clock_time: clockFinish,
      });

      // Drop any out-of-order splits (missing chip reads etc.)
      splitAnchors.sort((a, b) => a.elapsed_s - b.elapsed_s);
      for (let i = splitAnchors.length - 1; i > 0; i--) {
        if (splitAnchors[i].elapsed_s <= splitAnchors[i - 1].elapsed_s) {
          splitAnchors.splice(i, 1);
        }
      }

      return {
        year,
        race,
        chip_time:     chipTime,
        gun_time:      gunTime,
        start_time:    startTime,
        clock_finish:  clockFinish,
        finish_minute: finishMinute !== null ? Math.round(finishMinute * 100) / 100 : null,
        split_anchors: splitAnchors,
      };
    })
    .filter(r => r !== null);

  if (discarded > 0) {
    console.log(`    (${discarded} rows discarded — missing times, negative offset, or outside bounds)`);
  }

  return results;
}

// ─── Per-event fetch ──────────────────────────────────────────────────────────

async function fetchEvent(event) {
  console.log(`\n── ${event.year} (id: ${event.id}) ──────────────────────────`);

  const base    = `https://my2.raceresult.com/${event.id}/results`;
  const results = [];

  for (const race of RACES) {
    const fullName = `${event.listPrefix}|Overall Results - ${race}`;
    process.stdout.write(`  Fetching "${race}"… `);
    try {
      const encoded = encodeURIComponent(fullName);
      const url     = `${base}/list?key=${event.key}&listname=${encoded}&contest=0&r=all`;
      const raw     = await fetchJSON(url);

      if (raw.error) throw new Error(raw.error);

      const rows = parseRows(raw, `Overall Results - ${race}`, event.year, event.startTimes);
      results.push(...rows);
      console.log(`${rows.length} rows`);
    } catch (err) {
      console.error(`FAILED — ${err.message}`);
    }
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const allResults = [];
  const meta = { fetchedAt: new Date().toISOString(), events: [] };

  for (const event of EVENTS) {
    const rows = await fetchEvent(event);
    allResults.push(...rows);
    meta.events.push({
      year: event.year, id: event.id,
      count: rows.length, startTimes: event.startTimes,
    });
  }

  const outPath = join(__dirname, '../public/results.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ meta, results: allResults }, null, 2));

  console.log(`\n\n✓ ${allResults.length} total results → public/results.json`);

  const breakdown = allResults.reduce((acc, r) => {
    const k = `${r.year}  ${r.race}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  console.log('\nBreakdown:');
  Object.entries(breakdown).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  // Offset stats — confirm wave spread looks realistic after filtering
  console.log('\nOffset stats by race (min / median / max minutes):');
  const offsetsByRace = {};
  for (const r of allResults) {
    if (!r.split_anchors.length) continue;
    const k = `${r.year} ${r.race}`;
    if (!offsetsByRace[k]) offsetsByRace[k] = [];
    offsetsByRace[k].push(r.split_anchors[0].elapsed_s / 60);
  }
  for (const [k, offsets] of Object.entries(offsetsByRace).sort()) {
    offsets.sort((a, b) => a - b);
    const min    = offsets[0].toFixed(1);
    const median = offsets[Math.floor(offsets.length / 2)].toFixed(1);
    const max    = offsets[offsets.length - 1].toFixed(1);
    console.log(`  ${k}: min=${min} median=${median} max=${max}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });