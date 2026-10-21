/**
 * Admin API — full tournament control. All routes require the admin role.
 *
 *  POST /api/admin/login {username, password}
 *  Tournaments: GET /api/admin/tournaments, POST, PUT /api/admin/tournaments/:id
 *  Teams:       GET/POST /api/admin/teams, PUT/DELETE /api/admin/teams/:id
 *  Players:     GET/POST /api/admin/players, PUT/DELETE /api/admin/players/:id,
 *               POST /api/admin/players/:id/regenerate-pin
 *  Courses:     GET/POST /api/admin/courses, PUT /api/admin/courses/:id
 *  Matches:     GET /api/admin/matches, PUT /api/admin/matches/:id
 *  Pairings:    POST /api/admin/pairings, PUT/DELETE /api/admin/pairings/:id
 *  POST /api/admin/matches/:matchNo/generate-singles
 *  POST /api/admin/matches/:matchNo/lock  {locked: true|false}
 *  PUT  /api/admin/matches/3/scramble   {courses:[{course_id, points_scale, teams:[{team_id, tee_time}]}]}
 *  PUT  /api/admin/tournaments/:id/prizes
 *  POST /api/admin/change-password {current, next}
 */
'use strict';

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const LB = require('./leaderboards');
const S = require('./scoring');

const router = express.Router();

// Login is the one admin route that doesn't require an existing admin session.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare(`SELECT * FROM admins WHERE username = ?`).get(username);
  if (!admin || !(await auth.verifyPassword(password, admin.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const t = db.prepare(`SELECT * FROM tournaments ORDER BY year DESC LIMIT 1`).get();
  const token = auth.createSession({ role: 'admin', adminId: admin.id, tournamentId: t ? t.id : null });
  auth.setSessionCookie(res, token);
  res.json({ ok: true, role: 'admin', username: admin.username });
});

router.use(auth.requireAdmin);

// Push a live update to all connected clients after any successful mutation,
// so scoreboards/boards/schedules refresh everywhere in real time.
router.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (body && body.ok !== false) {
        const broadcast = req.app.locals.broadcast;
        if (broadcast) broadcast({ type: 'tournament_updated' });
      }
      return origJson(body);
    };
  }
  next();
});

function currentTournament() {
  return db.prepare(`SELECT * FROM tournaments ORDER BY year DESC LIMIT 1`).get();
}

const randomPin = () => String(Math.floor(1000 + Math.random() * 9000));

// ------------------------------------------------------------ tournaments

router.get('/tournaments', (req, res) => {
  res.json(db.prepare(`SELECT * FROM tournaments ORDER BY year DESC`).all());
});

router.post('/tournaments', (req, res) => {
  const { name, year, spectator_code, prize_settings } = req.body || {};
  if (!name || !year) return res.status(400).json({ error: 'name and year required' });
  const id = db.prepare(`
    INSERT INTO tournaments (name, year, spectator_code, prize_settings)
    VALUES (?, ?, ?, ?)
  `).run(name, year, spectator_code || null, JSON.stringify(prize_settings || {})).lastInsertRowid;
  res.json({ ok: true, id });
});

router.put('/tournaments/:id', (req, res) => {
  const { name, status, spectator_code, prize_settings } = req.body || {};
  const t = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE tournaments SET
      name = COALESCE(?, name),
      status = COALESCE(?, status),
      spectator_code = COALESCE(?, spectator_code),
      prize_settings = COALESCE(?, prize_settings)
    WHERE id = ?
  `).run(name ?? null, status ?? null, spectator_code ?? null,
         prize_settings ? JSON.stringify(prize_settings) : null, t.id);
  res.json({ ok: true });
});

router.put('/tournaments/:id/prizes', (req, res) => {
  const t = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE tournaments SET prize_settings = ? WHERE id = ?`)
    .run(JSON.stringify(req.body || {}), t.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ calcutta
//
// Thursday-night auction. Admin verifies Venmo payment before entering
// each bid (Venmo has no API — the paid flag records the human check).

router.post('/calcutta/bids', (req, res) => {
  const t = currentTournament();
  const { player_id, team_id, amount, paid } = req.body || {};
  const cents = Math.round(Number(amount) * 100);
  if (!player_id || !team_id || !Number.isFinite(cents) || cents <= 0) {
    return res.status(400).json({ error: 'player_id, team_id and a positive amount are required' });
  }
  const player = db.prepare(`SELECT id FROM players WHERE id = ? AND tournament_id = ?`).get(player_id, t.id);
  const team = db.prepare(`SELECT id FROM teams WHERE id = ? AND tournament_id = ?`).get(team_id, t.id);
  if (!player || !team) return res.status(400).json({ error: 'Player or team not found' });
  db.prepare(`
    INSERT INTO calcutta_bids (tournament_id, bidder_player_id, team_id, amount_cents, paid)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (tournament_id, bidder_player_id, team_id)
    DO UPDATE SET amount_cents = excluded.amount_cents, paid = excluded.paid
  `).run(t.id, player_id, team_id, cents, paid === false || paid === 0 ? 0 : 1);
  res.json({ ok: true });
});

router.patch('/calcutta/bids/:id', (req, res) => {
  const t = currentTournament();
  const bid = db.prepare(`SELECT * FROM calcutta_bids WHERE id = ? AND tournament_id = ?`)
    .get(req.params.id, t.id);
  if (!bid) return res.status(404).json({ error: 'Bid not found' });
  const { amount, paid } = req.body || {};
  let cents = bid.amount_cents, paidFlag = bid.paid;
  if (amount !== undefined) {
    cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ error: 'amount must be positive' });
  }
  if (paid !== undefined) paidFlag = paid ? 1 : 0;
  db.prepare(`UPDATE calcutta_bids SET amount_cents = ?, paid = ? WHERE id = ?`).run(cents, paidFlag, bid.id);
  res.json({ ok: true });
});

router.delete('/calcutta/bids/:id', (req, res) => {
  const t = currentTournament();
  db.prepare(`DELETE FROM calcutta_bids WHERE id = ? AND tournament_id = ?`).run(req.params.id, t.id);
  res.json({ ok: true });
});

// Wipe all Calcutta bids (fresh auction).
router.delete('/calcutta/bids', (req, res) => {
  const t = currentTournament();
  const r = db.prepare(`DELETE FROM calcutta_bids WHERE tournament_id = ?`).run(t.id);
  res.json({ ok: true, removed: r.changes });
});

// Payout split: % of the paid pool to 1st/2nd/3rd place teams. Must sum to 100.
router.put('/calcutta/payouts', (req, res) => {
  const t = currentTournament();
  const parts = [1, 2, 3].map(k => Number((req.body || {})[k]));
  if (parts.some(p => !Number.isFinite(p) || p < 0)) {
    return res.status(400).json({ error: 'Payouts must be non-negative numbers' });
  }
  if (Math.round(parts.reduce((s, p) => s + p, 0)) !== 100) {
    return res.status(400).json({ error: 'Payouts must add up to 100%' });
  }
  db.prepare(`UPDATE tournaments SET calcutta_payouts = ? WHERE id = ?`)
    .run(JSON.stringify({ 1: parts[0], 2: parts[1], 3: parts[2] }), t.id);
  res.json({ ok: true });
});

// Calcutta settings: open/close player betting, Venmo username for payments.
router.put('/calcutta/settings', (req, res) => {
  const t = currentTournament();
  const { open, venmo_username } = req.body || {};
  const sets = [], vals = [];
  if (open !== undefined) { sets.push('calcutta_open = ?'); vals.push(open ? 1 : 0); }
  if (venmo_username !== undefined) {
    const u = String(venmo_username).trim().replace(/^@/, '');
    if (u && !/^[A-Za-z0-9._-]{3,30}$/.test(u)) {
      return res.status(400).json({ error: 'That Venmo username looks invalid' });
    }
    sets.push('venmo_username = ?'); vals.push(u || null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?`).run(...vals, t.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ teams

router.get('/teams', (req, res) => {
  const t = currentTournament();
  res.json(db.prepare(`SELECT * FROM teams WHERE tournament_id = ? ORDER BY sort_order`).all(t.id));
});

router.post('/teams', (req, res) => {
  const t = currentTournament();
  const { color, sort_order } = req.body || {};
  if (!color) return res.status(400).json({ error: 'color required' });
  const id = db.prepare(`INSERT INTO teams (tournament_id, color, sort_order) VALUES (?, ?, ?)`)
    .run(t.id, color, sort_order ?? 99).lastInsertRowid;
  res.json({ ok: true, id });
});

router.put('/teams/:id', (req, res) => {
  const { color, sort_order } = req.body || {};
  db.prepare(`UPDATE teams SET color = COALESCE(?, color), sort_order = COALESCE(?, sort_order) WHERE id = ?`)
    .run(color ?? null, sort_order ?? null, req.params.id);
  res.json({ ok: true });
});

router.delete('/teams/:id', (req, res) => {
  db.prepare(`DELETE FROM teams WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- players

router.get('/players', (req, res) => {
  const t = currentTournament();
  res.json(db.prepare(`
    SELECT p.*, tm.color AS team_color FROM players p
    LEFT JOIN teams tm ON tm.id = p.team_id
    WHERE p.tournament_id = ? ORDER BY tm.sort_order, p.name
  `).all(t.id));
});

// Strokes per course: every player's course handicap on each course (black tees,
// same formula scoring uses).
router.get('/strokes', (req, res) => {
  const t = currentTournament();
  const courses = db.prepare(`
    SELECT id, name, black_slope, black_rating, black_par FROM courses
    WHERE tournament_id = ? ORDER BY name
  `).all(t.id);
  const players = db.prepare(`
    SELECT p.id, p.name, p.ghin_index, p.tier, tm.color AS team_color FROM players p
    LEFT JOIN teams tm ON tm.id = p.team_id
    WHERE p.tournament_id = ? ORDER BY tm.sort_order, p.name
  `).all(t.id);
  res.json({
    courses: courses.map(c => ({ id: c.id, name: c.name })),
    players: players.map(p => ({
      id: p.id, name: p.name, team_color: p.team_color, tier: p.tier, ghin_index: p.ghin_index,
      strokes: courses.map(c => (p.ghin_index != null && c.black_slope && c.black_rating && c.black_par)
        ? S.courseHandicap(p.ghin_index, c.black_slope, c.black_rating, c.black_par)
        : null)
    }))
  });
});

router.post('/players', (req, res) => {
  const t = currentTournament();
  const { team_id, name, ghin_index, tier } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = db.prepare(`
    INSERT INTO players (tournament_id, team_id, name, ghin_index, tier, claim_pin)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(t.id, team_id || null, name, ghin_index ?? 0, tier || null, randomPin()).lastInsertRowid;
  res.json({ ok: true, id });
});

router.put('/players/:id', (req, res) => {
  const { team_id, name, ghin_index, tier } = req.body || {};
  db.prepare(`
    UPDATE players SET team_id = COALESCE(?, team_id), name = COALESCE(?, name),
      ghin_index = COALESCE(?, ghin_index), tier = COALESCE(?, tier)
    WHERE id = ?
  `).run(team_id ?? null, name ?? null, ghin_index ?? null, tier ?? null, req.params.id);
  res.json({ ok: true });
});

router.delete('/players/:id', (req, res) => {
  db.prepare(`DELETE FROM players WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

router.post('/players/:id/regenerate-pin', (req, res) => {
  const pin = randomPin();
  db.prepare(`UPDATE players SET claim_pin = ? WHERE id = ?`).run(pin, req.params.id);
  res.json({ ok: true, claim_pin: pin });
});

// ----------------------------------------------------------------- courses

router.get('/courses', (req, res) => {
  const t = currentTournament();
  res.json(db.prepare(`SELECT * FROM courses WHERE tournament_id = ? ORDER BY name`).all(t.id));
});

router.post('/courses', (req, res) => {
  const t = currentTournament();
  const c = req.body || {};
  if (!c.name) return res.status(400).json({ error: 'name required' });
  const id = db.prepare(`
    INSERT INTO courses (tournament_id, name, black_rating, black_slope, black_par, black_yardage,
                         white_rating, white_slope, white_par, white_yardage, holes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.id, c.name, c.black_rating ?? null, c.black_slope ?? null, c.black_par ?? null,
         c.black_yardage ?? null, c.white_rating ?? null, c.white_slope ?? null,
         c.white_par ?? null, c.white_yardage ?? null, JSON.stringify(c.holes || []));
  res.json({ ok: true, id });
});

router.put('/courses/:id', (req, res) => {
  const c = req.body || {};
  const cols = ['name', 'black_rating', 'black_slope', 'black_par', 'black_yardage',
                'white_rating', 'white_slope', 'white_par', 'white_yardage'];
  const sets = [], vals = [];
  for (const col of cols) {
    if (c[col] !== undefined) { sets.push(`${col} = ?`); vals.push(c[col]); }
  }
  if (c.holes !== undefined) { sets.push('holes_json = ?'); vals.push(JSON.stringify(c.holes)); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE courses SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// ----------------------------------------------------------------- matches

router.get('/matches', (req, res) => {
  const t = currentTournament();
  res.json(db.prepare(`SELECT * FROM matches WHERE tournament_id = ? ORDER BY match_no`).all(t.id));
});

router.put('/matches/:id', (req, res) => {
  const { label, day, status, locked } = req.body || {};
  const lockedVal = locked === undefined ? null : (locked ? 1 : 0); // SQLite: 0/1, not booleans
  db.prepare(`
    UPDATE matches SET label = COALESCE(?, label), day = COALESCE(?, day),
      status = COALESCE(?, status), locked = COALESCE(?, locked)
    WHERE id = ?
  `).run(label ?? null, day ?? null, status ?? null, lockedVal, req.params.id);
  res.json({ ok: true });
});

router.post('/matches/:matchNo/lock', (req, res) => {
  const t = currentTournament();
  const m = db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND match_no = ?`)
    .get(t.id, Number(req.params.matchNo));
  if (!m) return res.status(404).json({ error: 'Match not found' });
  const locked = req.body && req.body.locked === false ? 0 : 1;
  db.prepare(`UPDATE matches SET locked = ? WHERE id = ?`).run(locked, m.id);
  res.json({ ok: true, locked: !!locked });
});

// ---------------------------------------------------------------- pairings

router.post('/pairings', (req, res) => {
  const { match_id, tee_time, course_id, course_label, unit_type, side_a_team_id, side_b_team_id, players } = req.body || {};
  if (!match_id || !unit_type) return res.status(400).json({ error: 'match_id and unit_type required' });
  const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(match_id);
  if (!m || m.locked) return res.status(403).json({ error: 'Match not found or locked' });
  const pid = db.prepare(`
    INSERT INTO pairings (match_id, tee_time, course_id, course_label, unit_type, side_a_team_id, side_b_team_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(match_id, tee_time || null, course_id || null, course_label || null, unit_type,
         side_a_team_id || null, side_b_team_id || null).lastInsertRowid;
  if (Array.isArray(players)) {
    const ins = db.prepare(`INSERT INTO pairing_players (pairing_id, player_id, side) VALUES (?, ?, ?)`);
    for (const p of players) ins.run(pid, p.player_id, p.side);
  }
  res.json({ ok: true, id: pid });
});

router.put('/pairings/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(p.match_id);
  const { tee_time, course_id, course_label, side_a_team_id, side_b_team_id, locked } = req.body || {};
  if (m.locked) return res.status(403).json({ error: 'Match is locked' });
  // A locked pairing only accepts an unlock — everything else needs it open.
  if (p.locked && locked !== false) return res.status(403).json({ error: 'Pairing is locked' });
  // SQLite has no boolean type — bind 0/1, not true/false.
  const lockedVal = locked === undefined ? null : (locked ? 1 : 0);
  db.prepare(`
    UPDATE pairings SET tee_time = COALESCE(?, tee_time), course_id = COALESCE(?, course_id),
      course_label = COALESCE(?, course_label),
      side_a_team_id = COALESCE(?, side_a_team_id), side_b_team_id = COALESCE(?, side_b_team_id),
      locked = COALESCE(?, locked)
    WHERE id = ?
  `).run(tee_time ?? null, course_id ?? null, course_label ?? null,
         side_a_team_id ?? null, side_b_team_id ?? null, lockedVal, p.id);
  res.json({ ok: true });
});

router.delete('/pairings/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(p.match_id);
  if (m.locked || p.locked) return res.status(403).json({ error: 'Locked' });
  db.prepare(`DELETE FROM pairings WHERE id = ?`).run(p.id);
  res.json({ ok: true });
});

// ------------------------------------------------------- singles generation

/**
 * Generate Saturday singles (Matches 6 & 7) from current team standings.
 * Per tier, players ordered by team standing; M6: 1v4 2v3 5v8 6v7 9v10 ...;
 * M7: 1v2 3v4 5v6 7v8 9v10 ... (1-based ranks within tier).
 * Foursomes: A+D share tee times, then B+C. Re-runnable until locked.
 */
function pairingFormulas(matchNo, count) {
  // Returns array of [rankA, rankB] (1-based ranks within tier), in TEE TIME ORDER.
  // M6 (from Trice's spreadsheet): 9v10, 7v8, 5v6, 2v3, 1v4
  // M7 (from Trice's spreadsheet): 9v8, 5v10, 6v7, 4v3, 1v2
  if (matchNo === 6) {
    // Top 4 cross: 1v4, 2v3; rest consecutive: 5v6, 7v8, 9v10...
    // Return in tee-time order: 9v10 first, 1v4 last.
    const top = [[1, 4], [2, 3]];
    const rest = [];
    for (let r = 5; r + 1 <= count; r += 2) rest.push([r, r + 1]);
    return [...rest.reverse(), ...top.reverse()];
  } else {
    // M7: from spreadsheet — 9v8, 5v10, 6v7, 3v4, 1v2 (in tee-time order)
    // For 10 players: [9,8], [5,10], [6,7], [3,4], [1,2]
    // Generalized: top 4 as 1v2, 3v4; bottom 6 as 9v8, 5v10, 6v7
    if (count === 10) {
      return [[9, 8], [5, 10], [6, 7], [3, 4], [1, 2]];
    }
    // Fallback for other counts: 1v2, 3v4, 5v6... reversed
    const pairs = [];
    for (let r = 1; r + 1 <= count; r += 2) pairs.push([r, r + 1]);
    return pairs.reverse();
  }
}

router.post('/matches/:matchNo/generate-singles', (req, res) => {
  const t = currentTournament();
  const matchNo = Number(req.params.matchNo);
  if (matchNo !== 6 && matchNo !== 7) {
    return res.status(400).json({ error: 'Singles generation is only for Matches 6 and 7' });
  }
  const m = db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND match_no = ?`).get(t.id, matchNo);
  if (!m) return res.status(404).json({ error: 'Match not found' });
  // Note: generate-singles works even if locked — it replaces pairings, doesn't edit scores.

  const board = LB.computeMasterLeaderboard(t.id);
  const standingByTeam = new Map(board.teams.map(tm => [tm.teamId, tm.place])); // 1-based
  const dye = db.prepare(`SELECT * FROM courses WHERE tournament_id = ? AND name = 'Dye'`).get(t.id);

  const tiers = ['A', 'B', 'C', 'D'];
  const playersByTier = {};
  for (const tier of tiers) {
    playersByTier[tier] = db.prepare(`
      SELECT p.*, tm.id AS tid FROM players p JOIN teams tm ON tm.id = p.team_id
      WHERE p.tournament_id = ? AND p.tier = ?
    `).all(t.id, tier)
      .sort((a, b) => (standingByTeam.get(a.tid) || 99) - (standingByTeam.get(b.tid) || 99));
  }
  const perTier = playersByTier.A.length;
  if (!perTier || tiers.some(tr => playersByTier[tr].length !== perTier)) {
    return res.status(400).json({ error: 'Tiers must have equal player counts to generate singles' });
  }

  const formulas = pairingFormulas(matchNo, perTier);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM pairings WHERE match_id = ?`).run(m.id);
    const insP = db.prepare(`
      INSERT INTO pairings (match_id, tee_time, course_id, course_label, unit_type, side_a_team_id, side_b_team_id)
      VALUES (?, ?, ?, 'Dye', 'single', ?, ?)
    `);
    const insPP = db.prepare(`INSERT INTO pairing_players (pairing_id, player_id, side) VALUES (?, ?, ?)`);
    // Tee times: A+D foursomes first, then B+C. 9-minute intervals from 1:53 PM (per Trice's sheet).
    let slot = 0;
    const teeTimeFor = (i) => {
      const mins = 13 * 60 + 53 + i * 9;
      const h = Math.floor(mins / 60), mm = mins % 60;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h > 12 ? h - 12 : h;
      return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
    };
    for (const [tierX, tierY] of [['A', 'D'], ['B', 'C']]) {
      for (const [ra, rb] of formulas) {
        const tee = teeTimeFor(slot++);
        for (const tier of [tierX, tierY]) {
          const pa = playersByTier[tier][ra - 1], pb = playersByTier[tier][rb - 1];
          const pid = insP.run(m.id, tee, dye ? dye.id : null, pa.tid, pb.tid).lastInsertRowid;
          insPP.run(pid, pa.id, 'A');
          insPP.run(pid, pb.id, 'B');
        }
      }
    }
  });
  tx();

  const count = db.prepare(`SELECT COUNT(*) AS n FROM pairings WHERE match_id = ?`).get(m.id).n;
  res.json({ ok: true, pairings: count });
});

// ---------------------------------------------------------- scramble setup

/**
 * PUT /api/admin/matches/3/scramble
 * { courses: [ { course_id, points_scale: [...], teams: [ {team_id, tee_time} ] } ] }
 * Replaces scramble_courses rows and Match 3 pairings.
 */
router.put('/matches/3/scramble', (req, res) => {
  const t = currentTournament();
  const m = db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND match_no = 3`).get(t.id);
  if (!m) return res.status(404).json({ error: 'Match 3 not found' });
  if (m.locked) return res.status(403).json({ error: 'Match 3 is locked' });
  const { courses } = req.body || {};
  if (!Array.isArray(courses) || !courses.length) {
    return res.status(400).json({ error: 'courses[] required' });
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM pairings WHERE match_id = ?`).run(m.id);
    db.prepare(`DELETE FROM scramble_courses WHERE match_id = ?`).run(m.id);
    const insP = db.prepare(`
      INSERT INTO pairings (match_id, tee_time, course_id, course_label, unit_type, side_a_team_id)
      VALUES (?, ?, ?, ?, 'team', ?)
    `);
    const insPP = db.prepare(`INSERT INTO pairing_players (pairing_id, player_id, side) VALUES (?, ?, 'A')`);
    for (const c of courses) {
      db.prepare(`INSERT INTO scramble_courses (match_id, course_id, points_scale) VALUES (?, ?, ?)`)
        .run(m.id, c.course_id, JSON.stringify(c.points_scale || []));
      const courseName = db.prepare(`SELECT name FROM courses WHERE id = ?`).get(c.course_id).name;
      for (const tm of c.teams || []) {
        const pid = insP.run(m.id, tm.tee_time || null, c.course_id, courseName, tm.team_id).lastInsertRowid;
        for (const pl of db.prepare(`SELECT id FROM players WHERE team_id = ?`).all(tm.team_id)) {
          insPP.run(pid, pl.id);
        }
      }
    }
  });
  tx();
  res.json({ ok: true });
});

// ------------------------------------------------------------ score export

/**
 * Admin score export — every player's individual gross and net scores
 * broken down by course (Trice, 2026-10-13).
 * GET /api/admin/scores/export      → JSON (powers the Admin section UI +
 *                                      copy-to-clipboard in the frontend)
 * GET /api/admin/scores/export.csv  → CSV download, one row per player/course
 */
router.get('/scores/export', (req, res) => {
  const t = currentTournament();
  res.json(LB.computeScoreExport(t.id));
});

router.get('/scores/export.csv', (req, res) => {
  const t = currentTournament();
  const csv = LB.scoreExportCSV(LB.computeScoreExport(t.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fellas-${t.year}-scores.csv"`);
  res.send(csv);
});

// ------------------------------------------------------------ admin account

router.post('/change-password', async (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next || next.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const admin = db.prepare(`SELECT * FROM admins WHERE id = ?`).get(req.session.admin_id);
  if (!(await auth.verifyPassword(current, admin.password_hash))) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  db.prepare(`UPDATE admins SET password_hash = ? WHERE id = ?`)
    .run(await auth.hashPassword(next), admin.id);
  res.json({ ok: true });
});

// Clear all scores (Admin Danger Zone — double-confirm in UI).
// Also deletes generated M6/M7 singles pairings so they fall back to
// placeholder (TBD) cards; M1–M5 pairings are untouched.
router.post('/clear-all-scores', (req, res) => {
  const t = currentTournament();
  db.prepare(`DELETE FROM hole_scores`).run();
  db.prepare(`DELETE FROM scramble_scores`).run();
  // Finalize locks pairings (pairings.locked = 1) and POST /scores rejects
  // locked pairings — so a wipe that only deletes score rows would leave
  // the surviving M1–M5 pairings stuck "✓ Finalized" with no scores and no
  // way to enter new ones. Unlock this tournament's pairings along with
  // the wipe. (M6/M7 pairings are deleted below anyway. matches.locked is
  // a separate manual admin lock, not finalize state — left alone.)
  const unlocked = db.prepare(`
    UPDATE pairings SET locked = 0
    WHERE locked = 1 AND match_id IN (SELECT id FROM matches WHERE tournament_id = ?)
  `).run(t.id).changes;
  const m67 = db.prepare(`SELECT id FROM matches WHERE tournament_id = ? AND match_no IN (6, 7)`).all(t.id);
  let pairingsCleared = 0;
  for (const m of m67) {
    pairingsCleared += db.prepare(`DELETE FROM pairings WHERE match_id = ?`).run(m.id).changes;
  }
  const h = db.prepare(`SELECT COUNT(*) AS c FROM hole_scores`).get().c;
  const s = db.prepare(`SELECT COUNT(*) AS c FROM scramble_scores`).get().c;
  // Notify connected clients like every other score mutation does, so an
  // open Scoring tab drops the "✓ Finalized" tag without a manual reload.
  const broadcast = req.app.locals.broadcast;
  if (broadcast) broadcast({ type: 'scores_updated' });
  res.json({ ok: true, hole_scores: h, scramble_scores: s, singles_pairings_cleared: pairingsCleared, pairings_unlocked: unlocked });
});

module.exports = router;
