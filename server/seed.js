/**
 * Seed script — loads the 2026 test tournament.
 *
 * Source: ~/workspace/fellas-invitational-scoring/test-data-2026.md
 * Scramble points scales use the CORRECTED 2026-10-13 values
 * (Norman 40/30/25/20/15/10, Fazio 40/30/20/10).
 *
 * Hole pars/stroke-indexes are clearly-marked PLACEHOLDERS — Trice verifies
 * against real scorecards in Admin.
 *
 * Usage: node server/seed.js
 * Idempotent: wipes the 2026 tournament before reseeding.
 */
'use strict';

const db = require('./db');
const { hashPassword } = require('./auth');

// ------------------------------------------------------------------ data

const TEAMS = [
  { color: 'Orange', players: [['Bradley', 5.0], ['Mercer', 7.3], ['Trice', 11.1], ['Will M', 16.6]] },
  { color: 'Green',  players: [['James', 6.8], ['William L', 6.8], ['Trevor', 10.0], ['Kyle', 12.7]] },
  { color: 'Blue',   players: [['Jay', 3.8], ['Lee', 8.8], ['Max', 12.4], ['Peter', 14.0]] },
  { color: 'Red',    players: [['Phillip G', 5.8], ['Haigen', 7.0], ['Rob', 12.3], ['Will G', 20.0]] },
  { color: 'Purple', players: [['Sharp', 3.9], ['Walker A', 10.5], ['Weston', 10.2], ['Sam', 17.1]] },
  { color: 'Yellow', players: [['Robinson', 4.7], ['Thomas', 7.8], ['Steven', 10.7], ['Philip H', 16.8]] },
  { color: 'Navy',   players: [['Grier', 0.6], ['Reynolds', 7.0], ['Hunter', 12.3], ['Banks', 13.2]] },
  { color: 'Maroon', players: [['Harrison', 2.1], ['Preston', 8.9], ['Parker', 10.6], ['Doug', 14.1]] },
  { color: 'Teal',   players: [['Cason', 5.3], ['Michael', 9.4], ['Aaron', 9.9], ['Ned', 17.3]] },
  { color: 'Coral',  players: [['Churchill', 1.0], ['Reid', 9.1], ['Walker P', 10.6], ['Robert', 17.5]] },
];

const TIERS = {
  A: ['Grier', 'Churchill', 'Harrison', 'Jay', 'Sharp', 'Robinson', 'Bradley', 'Cason', 'Phillip G', 'James'],
  B: ['William L', 'Haigen', 'Reynolds', 'Mercer', 'Thomas', 'Lee', 'Preston', 'Reid', 'Michael', 'Aaron'],
  C: ['Trevor', 'Weston', 'Walker A', 'Parker', 'Walker P', 'Steven', 'Trice', 'Rob', 'Hunter', 'Max'],
  D: ['Kyle', 'Banks', 'Peter', 'Doug', 'Will M', 'Philip H', 'Sam', 'Ned', 'Robert', 'Will G'],
};

// Placeholder hole data: [par, strokeIndex] x18. VERIFY AGAINST REAL SCORECARDS.
function placeholderHoles(pars) {
  const siFront = [7, 15, 3, 11, 1, 17, 9, 5, 13];
  const siBack = [8, 16, 4, 12, 2, 18, 10, 6, 14];
  return pars.map((par, i) => ({ par, si: i < 9 ? siFront[i] : siBack[i - 9] }));
}
const PARS_72 = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 5, 4, 4, 3, 4, 5, 4]; // sums to 72
const PARS_71 = [4, 3, 4, 4, 4, 3, 4, 5, 4, 4, 5, 3, 4, 4, 4, 5, 3, 4]; // sums to 71

const COURSES = [
  // name, black {rating, slope, par, yds}, white {rating, slope, par, yds}, pars
  { name: 'Dye',    black: [72.7, 135, 72, 6800], white: [70.0, 132, 72, 6200], pars: PARS_72 },
  { name: 'Fazio',  black: [71.0, 136, 71, 6350], white: [67.8, 123, 71, 5800], pars: PARS_71 },
  { name: 'Love',   black: [72.4, 137, 72, 6900], white: [69.8, 123, 72, 6300], pars: PARS_72 },
  { name: 'Norman', black: [71.4, 136, 72, 6700], white: [68.7, 125, 72, 6100], pars: PARS_72 },
];

const MATCHES = [
  { no: 1, label: 'Match 1 · Friday AM Front Nine',  day: 'Friday',   format: 'bestball', segment: 'front' },
  { no: 2, label: 'Match 2 · Friday AM Back Nine',   day: 'Friday',   format: 'bestball', segment: 'back' },
  { no: 3, label: 'Match 3 · Friday PM Scramble',    day: 'Friday',   format: 'scramble', segment: 'full' },
  { no: 4, label: 'Match 4 · Saturday AM Front Nine', day: 'Saturday', format: 'bestball', segment: 'front' },
  { no: 5, label: 'Match 5 · Saturday AM Back Nine',  day: 'Saturday', format: 'bestball', segment: 'back' },
  { no: 6, label: 'Match 6 · Saturday PM Singles',   day: 'Saturday', format: 'singles',  segment: 'front' },
  { no: 7, label: 'Match 7 · Saturday PM Singles',   day: 'Saturday', format: 'singles',  segment: 'back' },
];

// [matchNo, teeTime, courseName, courseLabel, sideA names, sideB names]
const PAIRINGS = [
  // Match 1 — Fri AM front 9
  [1, '8:04 AM', 'Fazio', 'Fazio', ['Bradley', 'Mercer'], ['Robinson', 'Thomas']],
  [1, '8:12 AM', 'Fazio', 'Fazio', ['James', 'William L'], ['Grier', 'Reynolds']],
  [1, '8:20 AM', 'Fazio', 'Fazio', ['Jay', 'Lee'], ['Harrison', 'Preston']],
  [1, '8:28 AM', 'Fazio', 'Fazio', ['Trice', 'Will M'], ['Steven', 'Philip H']],
  [1, '8:36 AM', 'Fazio', 'Fazio', ['Trevor', 'Kyle'], ['Hunter', 'Banks']],
  [1, '8:44 AM', 'Fazio', 'Fazio', ['Max', 'Peter'], ['Parker', 'Doug']],
  [1, '8:04 AM', 'Norman', 'Norman', ['Phillip G', 'Haigen'], ['Sharp', 'Walker A']],
  [1, '8:12 AM', 'Norman', 'Norman', ['Churchill', 'Reid'], ['Cason', 'Michael']],
  [1, '8:20 AM', 'Norman', 'Norman', ['Rob', 'Will G'], ['Weston', 'Sam']],
  [1, '8:28 AM', 'Norman', 'Norman', ['Walker P', 'Robert'], ['Aaron', 'Ned']],
  // Match 2 — Fri AM back 9
  [2, null, 'Fazio', 'Fazio Back', ['Bradley', 'Mercer'], ['Grier', 'Reynolds']],
  [2, null, 'Fazio', 'Fazio Back', ['Robinson', 'Thomas'], ['Harrison', 'Preston']],
  [2, null, 'Fazio', 'Fazio Back', ['Jay', 'Lee'], ['James', 'William L']],
  [2, null, 'Fazio', 'Fazio Back', ['Trice', 'Will M'], ['Hunter', 'Banks']],
  [2, null, 'Fazio', 'Fazio Back', ['Steven', 'Philip H'], ['Parker', 'Doug']],
  [2, null, 'Fazio', 'Fazio Back', ['Max', 'Peter'], ['Trevor', 'Kyle']],
  [2, null, 'Norman', 'Norman Back', ['Phillip G', 'Haigen'], ['Cason', 'Michael']],
  [2, null, 'Norman', 'Norman Back', ['Churchill', 'Reid'], ['Sharp', 'Walker A']],
  [2, null, 'Norman', 'Norman Back', ['Rob', 'Will G'], ['Aaron', 'Ned']],
  [2, null, 'Norman', 'Norman Back', ['Walker P', 'Robert'], ['Weston', 'Sam']],
  // Match 4 — Sat AM front 9 (reshuffled)
  [4, '7:51 AM', 'Love', 'Love Front', ['Bradley', 'Trice'], ['Harrison', 'Parker']],
  [4, '7:59 AM', 'Love', 'Love Front', ['James', 'Trevor'], ['Phillip G', 'Rob']],
  [4, '8:08 AM', 'Love', 'Love Front', ['Cason', 'Aaron'], ['Sharp', 'Weston']],
  [4, '8:16 AM', 'Love', 'Love Front', ['Mercer', 'Will M'], ['Preston', 'Doug']],
  [4, '8:24 AM', 'Love', 'Love Front', ['William L', 'Kyle'], ['Haigen', 'Will G']],
  [4, '8:32 AM', 'Love', 'Love Front', ['Michael', 'Ned'], ['Walker A', 'Sam']],
  [4, '7:51 AM', 'Love', 'Love Back', ['Reynolds', 'Banks'], ['Lee', 'Peter']],
  [4, '7:59 AM', 'Love', 'Love Back', ['Reid', 'Robert'], ['Thomas', 'Philip H']],
  [4, '8:08 AM', 'Love', 'Love Back', ['Grier', 'Hunter'], ['Jay', 'Max']],
  [4, '8:16 AM', 'Love', 'Love Back', ['Churchill', 'Walker P'], ['Robinson', 'Steven']],
  // Match 5 — Sat AM back 9 (reshuffled)
  [5, null, 'Love', 'Love Back', ['Bradley', 'Trice'], ['Phillip G', 'Rob']],
  [5, null, 'Love', 'Love Back', ['Cason', 'Aaron'], ['Harrison', 'Parker']],
  [5, null, 'Love', 'Love Back', ['Sharp', 'Weston'], ['James', 'Trevor']],
  [5, null, 'Love', 'Love Back', ['Mercer', 'Will M'], ['Haigen', 'Will G']],
  [5, null, 'Love', 'Love Back', ['Michael', 'Ned'], ['Preston', 'Doug']],
  [5, null, 'Love', 'Love Back', ['Walker A', 'Sam'], ['William L', 'Kyle']],
  [5, null, 'Love', 'Love Front', ['Reynolds', 'Banks'], ['Thomas', 'Philip H']],
  [5, null, 'Love', 'Love Front', ['Lee', 'Peter'], ['Reid', 'Robert']],
  [5, null, 'Love', 'Love Front', ['Grier', 'Hunter'], ['Robinson', 'Steven']],
  [5, null, 'Love', 'Love Front', ['Jay', 'Max'], ['Churchill', 'Walker P']],
];

// Match 3 scramble: [teeTime, courseName, teamColor]
const SCRAMBLE = [
  ['2:34 PM', 'Norman', 'Orange'], ['2:43 PM', 'Norman', 'Navy'],
  ['2:52 PM', 'Norman', 'Yellow'], ['3:01 PM', 'Norman', 'Maroon'],
  ['3:10 PM', 'Norman', 'Green'],  ['3:19 PM', 'Norman', 'Blue'],
  ['2:52 PM', 'Fazio', 'Red'], ['3:01 PM', 'Fazio', 'Teal'],
  ['3:10 PM', 'Fazio', 'Purple'], ['3:19 PM', 'Fazio', 'Coral'],
];
const SCRAMBLE_SCALES = { Norman: [40, 30, 25, 20, 15, 10], Fazio: [40, 30, 20, 10] };

const PRIZES = {
  first: 4000, second: 800,
  weekendLowNet: 200,
  matchLowNet: 200,          // each of M1/2/4/5
  scrambleLowNet: 200,       // M3 overall
  singlesLowNet: 100,        // each of M6/7
  tierLowNet: 100,           // each tier A/B/C/D
  mvpPutter: 'The Fellas MVP Putter',
};

// ------------------------------------------------------------------ seeding

async function main() {
  const YEAR = 2026;

  // Wipe any existing 2026 tournament (idempotent reseed).
  const existing = db.prepare(`SELECT id FROM tournaments WHERE year = ?`).get(YEAR);
  if (existing) {
    db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(existing.id);
    console.log('Cleared existing 2026 tournament.');
  }

  const spectatorCode = 'FELLAS26';
  const t = db.prepare(`
    INSERT INTO tournaments (name, year, status, spectator_code, prize_settings)
    VALUES ('The Fellas', 2026, 'setup', ?, ?)
  `).run(spectatorCode, JSON.stringify(PRIZES)).lastInsertRowid;
  console.log(`Tournament id=${t}, spectator code=${spectatorCode}`);

  // Teams + players.
  const teamIdByColor = new Map();
  const playerIdByName = new Map();
  const tierByName = new Map();
  for (const [tier, names] of Object.entries(TIERS)) for (const n of names) tierByName.set(n, tier);

  TEAMS.forEach((tm, i) => {
    const teamId = db.prepare(`INSERT INTO teams (tournament_id, color, sort_order) VALUES (?, ?, ?)`)
      .run(t, tm.color, i).lastInsertRowid;
    teamIdByColor.set(tm.color, teamId);
    for (const [name, index] of tm.players) {
      const pin = String(Math.floor(1000 + Math.random() * 9000));
      const pid = db.prepare(`
        INSERT INTO players (tournament_id, team_id, name, ghin_index, tier, claim_pin)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(t, teamId, name, index, tierByName.get(name), pin).lastInsertRowid;
      playerIdByName.set(name, pid);
    }
  });
  console.log(`Seeded ${TEAMS.length} teams, ${playerIdByName.size} players.`);

  // Courses.
  const courseIdByName = new Map();
  for (const c of COURSES) {
    const [br, bs, bp, by] = c.black;
    const [wr, ws, wp, wy] = c.white;
    const id = db.prepare(`
      INSERT INTO courses (tournament_id, name, black_rating, black_slope, black_par, black_yardage,
                           white_rating, white_slope, white_par, white_yardage, holes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t, c.name, br, bs, bp, by, wr, ws, wp, wy, JSON.stringify(placeholderHoles(c.pars))).lastInsertRowid;
    courseIdByName.set(c.name, id);
  }
  console.log(`Seeded ${COURSES.length} courses (hole data = PLACEHOLDER).`);

  // Matches.
  const matchIdByNo = new Map();
  for (const m of MATCHES) {
    const id = db.prepare(`
      INSERT INTO matches (tournament_id, match_no, label, day, format, segment)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(t, m.no, m.label, m.day, m.format, m.segment).lastInsertRowid;
    matchIdByNo.set(m.no, id);
  }

  // Pairings for M1, M2, M4, M5.
  const insPairing = db.prepare(`
    INSERT INTO pairings (match_id, tee_time, course_id, course_label, unit_type, side_a_team_id, side_b_team_id)
    VALUES (?, ?, ?, ?, 'pair', ?, ?)
  `);
  const insPP = db.prepare(`INSERT INTO pairing_players (pairing_id, player_id, side) VALUES (?, ?, ?)`);
  const teamOf = (name) => {
    const row = db.prepare(`SELECT team_id FROM players WHERE tournament_id = ? AND name = ?`).get(t, name);
    return row.team_id;
  };

  for (const [matchNo, teeTime, courseName, courseLabel, sideA, sideB] of PAIRINGS) {
    const pid = insPairing.run(
      matchIdByNo.get(matchNo), teeTime, courseIdByName.get(courseName), courseLabel,
      teamOf(sideA[0]), teamOf(sideB[0])
    ).lastInsertRowid;
    for (const n of sideA) insPP.run(pid, playerIdByName.get(n), 'A');
    for (const n of sideB) insPP.run(pid, playerIdByName.get(n), 'B');
  }
  console.log(`Seeded ${PAIRINGS.length} pairings for Matches 1, 2, 4, 5.`);

  // Match 3 scramble setup.
  const m3 = matchIdByNo.get(3);
  const insScr = db.prepare(`
    INSERT INTO pairings (match_id, tee_time, course_id, course_label, unit_type, side_a_team_id)
    VALUES (?, ?, ?, ?, 'team', ?)
  `);
  for (const [teeTime, courseName, color] of SCRAMBLE) {
    const teamId = teamIdByColor.get(color);
    const pid = insScr.run(m3, teeTime, courseIdByName.get(courseName), courseName, teamId).lastInsertRowid;
    const members = db.prepare(`SELECT id FROM players WHERE team_id = ?`).all(teamId);
    for (const mbr of members) insPP.run(pid, mbr.id, 'A');
  }
  for (const [courseName, scale] of Object.entries(SCRAMBLE_SCALES)) {
    db.prepare(`INSERT INTO scramble_courses (match_id, course_id, points_scale) VALUES (?, ?, ?)`)
      .run(m3, courseIdByName.get(courseName), JSON.stringify(scale));
  }
  console.log('Seeded Match 3 scramble (Norman 6 teams, Fazio 4 teams).');

  // Admin user (change password after first login!).
  const adminPassword = process.env.ADMIN_PASSWORD || 'fellas-admin-2026';
  const ahash = await hashPassword(adminPassword);
  db.prepare(`INSERT INTO admins (username, password_hash) VALUES ('admin', ?)`)
    .run(ahash);
  console.log(`Admin user created: username=admin password=${adminPassword} (CHANGE THIS)`);

  console.log('\nDone. Player claim PINs (name: pin):');
  const pins = db.prepare(`SELECT name, claim_pin FROM players WHERE tournament_id = ? ORDER BY name`).all(t);
  for (const p of pins) console.log(`  ${p.name}: ${p.claim_pin}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
module.exports = main;
