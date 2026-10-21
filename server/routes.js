/**
 * Public + scoring API routes.
 *
 *  GET  /api/health
 *  GET  /api/tournament
 *  POST /api/auth/claim          {player_id, pin} -> player session
 *  POST /api/auth/spectator      {code} -> spectator session
 *  POST /api/auth/logout
 *  GET  /api/me
 *
 *  (auth: any signed-in role)
 *  GET  /api/leaderboard
 *  GET  /api/boards/match/:matchNo
 *  GET  /api/boards/weekend?tier=A
 *  GET  /api/schedule
 *  GET  /api/matches/:matchNo
 *  GET  /api/pairings/:id        (scores + evaluation for the scoring tab)
 *
 *  (scorer: claimed player or admin)
 *  POST /api/scores  {pairing_id, entries:[{kind, id, hole_no, gross}]}
 *      kind: 'player' (best ball/singles) or 'team' (scramble).
 *      gross: null deletes the stored score (hole back to "no score").
 *      Last write wins per hole, with "entered by" attribution.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const LB = require('./leaderboards');
const CAL = require('./calcutta');
const S = require('./scoring');

const router = express.Router();

/** The active tournament: latest year (admin can change status per edition). */
function currentTournament() {
  return db.prepare(`SELECT * FROM tournaments ORDER BY year DESC LIMIT 1`).get();
}

router.get('/health', (req, res) => res.json({ ok: true }));

router.get('/tournament', (req, res) => {
  const t = currentTournament();
  if (!t) return res.status(404).json({ error: 'No tournament yet' });
  res.json({
    id: t.id, name: t.name, year: t.year, status: t.status,
    prizes: t.prize_settings ? JSON.parse(t.prize_settings) : {},
  });
});

// ------------------------------------------------------------ auth

router.post('/auth/claim', (req, res) => {
  const { player_id, pin } = req.body || {};
  const t = currentTournament();
  if (!t) return res.status(404).json({ error: 'No tournament yet' });
  const player = db.prepare(`SELECT * FROM players WHERE id = ? AND tournament_id = ?`).get(player_id, t.id);
  if (!player || !player.claim_pin || player.claim_pin !== String(pin)) {
    return res.status(401).json({ error: 'Invalid player or PIN' });
  }
  const token = auth.createSession({ role: 'player', playerId: player.id, tournamentId: t.id });
  auth.setSessionCookie(res, token);
  res.json({ ok: true, role: 'player', player: { id: player.id, name: player.name } });
});

router.post('/auth/spectator', (req, res) => {
  const { code } = req.body || {};
  const t = currentTournament();
  if (!t || !t.spectator_code || t.spectator_code !== String(code).trim()) {
    return res.status(401).json({ error: 'Invalid spectator code' });
  }
  const token = auth.createSession({ role: 'spectator', tournamentId: t.id });
  auth.setSessionCookie(res, token);
  res.json({ ok: true, role: 'spectator' });
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(req.cookies[auth.COOKIE_NAME]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session) return res.json({ role: null });
  const out = { role: req.session.role };
  if (req.session.role === 'player') {
    out.player = db.prepare(`SELECT id, name, team_id FROM players WHERE id = ?`).get(req.session.player_id);
  }
  res.json(out);
});

// Public player roster for the "claim your player" picker (names/teams
// only — no PINs, no sensitive data).
router.get('/players', (req, res) => {
  const t = currentTournament();
  if (!t) return res.json([]);
  const teams = new Map(db.prepare(`SELECT id, color FROM teams WHERE tournament_id = ?`).all(t.id).map(x => [x.id, x.color]));
  const players = db.prepare(`SELECT id, name, team_id, tier, ghin_index FROM players WHERE tournament_id = ? ORDER BY name`).all(t.id);
  res.json(players.map(p => ({ id: p.id, name: p.name, tier: p.tier, ghin: p.ghin_index, team: teams.get(p.team_id) })));
});

// The logged-in player's own groups across all matches — the Scoring tab
// default (their group, not a hardcoded demo). Player role only.
router.get('/my/groups', auth.requireAuth, (req, res) => {
  if (!req.session || req.session.role !== 'player') {
    return res.status(403).json({ error: 'Player session required' });
  }
  const t = currentTournament();
  const data = LB.getPlayerGroups(t.id, req.session.player_id);
  if (!data) return res.status(404).json({ error: 'Player not found' });
  res.json(data);
});

// ------------------------------------------------------------ read models

router.get('/leaderboard', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  res.json(LB.computeMasterLeaderboard(t.id));
});

router.get('/boards/match/:matchNo', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const board = LB.computeMatchBoard(t.id, Number(req.params.matchNo));
  if (!board) return res.status(404).json({ error: 'Match not found' });
  res.json(board);
});

router.get('/boards/weekend', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const tier = req.query.tier && req.query.tier !== 'ALL' ? req.query.tier : null;
  res.json(LB.computeWeekendLowNet(t.id, tier));
});

// Per-nine Low Net boards: "Front 9 Low Net" / "Back 9 Low Net".
// Individuals; each player's own net summed across that nine's matches
// (front: M1+M4+M6, back: M2+M5+M7). Scramble excluded.
router.get('/boards/nine/:nine', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const nine = req.params.nine;
  if (nine !== 'front' && nine !== 'back') {
    return res.status(400).json({ error: "nine must be 'front' or 'back'" });
  }
  res.json(LB.computeNineLowNet(t.id, nine));
});

// Calcutta auction board + projected payouts (all signed-in roles).
router.get('/calcutta', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  res.json(CAL.getBoard(t.id));
});

router.get('/calcutta/payouts', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  res.json({ payouts: CAL.getPayouts(t.id) });
});

// The logged-in bidder's own bets. Players match by identity; spectators
// pass ?name= to match their typed name.
router.get('/calcutta/mine', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const role = req.session && req.session.role;
  if (role === 'player') return res.json({ bets: CAL.getMyBets(t.id, { playerId: req.session.player_id }) });
  if (role === 'spectator' && req.query.name) {
    return res.json({ bets: CAL.getMyBets(t.id, { name: String(req.query.name) }) });
  }
  return res.json({ bets: [] });
});

// Light anti-spam for spectator betting: max 20 bets/min per IP.
const _betHits = new Map();
function spectatorBetAllowed(ip) {
  const now = Date.now();
  const hits = (_betHits.get(ip) || []).filter(ts => now - ts < 60000);
  if (hits.length >= 20) return false;
  hits.push(now);
  _betHits.set(ip, hits);
  if (_betHits.size > 1000) {
    for (const [k, v] of _betHits) if (v.every(ts => now - ts >= 60000)) _betHits.delete(k);
  }
  return true;
}

// A claimed player — or a spectator with a typed name — bets on a team.
// Adds to any existing bid on that team. Bets start unpaid; admin marks
// paid after verifying Venmo.
router.post('/calcutta/bets', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const role = req.session && req.session.role;
  const isPlayer = role === 'player';
  const isSpectator = role === 'spectator';
  if (!isPlayer && !isSpectator) {
    return res.status(403).json({ error: 'Claim your player identity to bet' });
  }
  const live = CAL.getBoard(t.id);
  if (!live.open) return res.status(403).json({ error: 'Calcutta betting is closed' });
  const { team_id, amount } = req.body || {};
  const cents = Math.round(Number(amount) * 100);
  let who;
  if (isPlayer) {
    who = { playerId: req.session.player_id };
  } else {
    if (!spectatorBetAllowed(req.ip)) {
      return res.status(429).json({ error: 'Slow down — too many bets at once' });
    }
    who = { name: req.body && req.body.bidder_name };
  }
  const r = CAL.placeBet(t.id, who, team_id, cents);
  if (r.error) return res.status(400).json({ error: r.error });
  const broadcast = req.app.locals.broadcast;
  if (broadcast) broadcast({ type: 'tournament_updated' });
  const myBets = CAL.getMyBets(t.id, who);
  const myUnpaid = myBets.filter(b => !b.paid).reduce((s, b) => s + b.amount_cents, 0);
  res.json({ ok: true, board: CAL.getBoard(t.id), my_unpaid_cents: myUnpaid });
});

// ---- Internal automation (Venmo watcher) ----
// Guarded by INTERNAL_API_SECRET (Render env var). Lets the payment watcher
// list unpaid bids and mark them paid after matching a Venmo receipt.
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';
function requireInternal(req, res, next) {
  if (!INTERNAL_SECRET) return res.status(503).json({ error: 'Internal API not configured' });
  const got = String(req.get('X-Internal-Secret') || '');
  const a = Buffer.from(got), b = Buffer.from(INTERNAL_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

router.get('/internal/calcutta/pending', requireInternal, (req, res) => {
  const t = currentTournament();
  const board = CAL.getBoard(t.id);
  const pending = [];
  for (const tm of board.teams) {
    for (const b of tm.bids) {
      if (!b.paid) pending.push({ bid_id: b.id, name: b.name, amount_cents: b.amount_cents, team_color: tm.color });
    }
  }
  res.json({ pending });
});

router.post('/internal/calcutta/mark-paid', requireInternal, (req, res) => {
  const t = currentTournament();
  const bid = db.prepare(`SELECT id, paid FROM calcutta_bids WHERE id = ? AND tournament_id = ?`)
    .get(req.body && req.body.bid_id, t.id);
  if (!bid) return res.status(404).json({ error: 'Bid not found' });
  if (!bid.paid) {
    db.prepare(`UPDATE calcutta_bids SET paid = 1 WHERE id = ?`).run(bid.id);
    const broadcast = req.app.locals.broadcast;
    if (broadcast) broadcast({ type: 'tournament_updated' });
  }
  res.json({ ok: true, already_paid: !!bid.paid });
});

// Internal: set the Calcutta Venmo username (same validation as admin UI).
router.post('/internal/calcutta/venmo-username', requireInternal, (req, res) => {
  const t = currentTournament();
  const u = String((req.body && req.body.venmo_username) || '').trim().replace(/^@/, '');
  if (!u || !/^[A-Za-z0-9._-]{3,30}$/.test(u)) {
    return res.status(400).json({ error: 'That Venmo username looks invalid' });
  }
  db.prepare(`UPDATE tournaments SET venmo_username = ? WHERE id = ?`).run(u, t.id);
  res.json({ ok: true, venmo_username: u });
});

router.get('/schedule', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const playerId = req.session.role === 'player' ? req.session.player_id : null;
  res.json(LB.getSchedule(t.id, playerId));
});

router.get('/matches/:matchNo', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const detail = LB.getMatchDetail(t.id, Number(req.params.matchNo));
  if (!detail) return res.status(404).json({ error: 'Match not found' });
  res.json(detail);
});

router.get('/pairings/:id', auth.requireAuth, (req, res) => {
  const t = currentTournament();
  const pairing = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(req.params.id);
  if (!pairing) return res.status(404).json({ error: 'Pairing not found' });
  const match = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(pairing.match_id);
  if (match.tournament_id !== t.id) return res.status(404).json({ error: 'Not found' });
  const course = LB.getCourse(pairing.course_id);
  const detail = match.format === 'scramble'
    ? { format: 'scramble', evaluation: LB.evaluateScramblePairing(pairing, course) }
    : { format: match.format, evaluation: LB.evaluatePairing(pairing, match, course) };
  // Hole metadata (par / stroke index) for the match's segment, so the
  // scoring UI can show "Par 4 · SI 9" per hole without another round-trip.
  let holes = null;
  try {
    const meta = course && course.holes_json ? JSON.parse(course.holes_json) : null;
    if (meta && meta.length === 18) {
      holes = S.segmentHoles(match.segment).map(h => {
        const m = meta[h - 1];
        const hole = { hole: h, par: m.par, si: m.si };
        // Per-hole yardage rides along when the course data carries it
        // (a holes_json entry may add `yds`); omitted when not stored.
        const yds = m.yds ?? m.yards ?? m.yardage;
        if (yds != null) hole.yds = yds;
        return hole;
      });
    }
  } catch { /* leave holes null */ }
  // Who may this scorer enter for? Their pairing-mates (or anyone, if admin).
  // Current per-hole gross scores, so the scoring UI can prefill steppers:
  // { playerId: {holeNo: gross} } (or { teamId: {...} } for scramble).
  const scores = {};
  if (match.format === 'scramble') {
    for (const r of db.prepare(`SELECT team_id AS id, hole_no, gross FROM scramble_scores WHERE pairing_id = ?`).all(pairing.id)) {
      (scores[r.id] = scores[r.id] || {})[r.hole_no] = r.gross;
    }
  } else {
    for (const r of db.prepare(`SELECT player_id AS id, hole_no, gross FROM hole_scores WHERE pairing_id = ?`).all(pairing.id)) {
      (scores[r.id] = scores[r.id] || {})[r.hole_no] = r.gross;
    }
  }
  res.json({ pairing, match, holes, scores, ...detail });
});

// ------------------------------------------------------------ score entry

router.post('/scores', auth.requireScorer, (req, res) => {
  const t = currentTournament();
  const { pairing_id, entries } = req.body || {};
  if (!pairing_id || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'pairing_id and entries[] required' });
  }
  const pairing = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(pairing_id);
  if (!pairing) return res.status(404).json({ error: 'Pairing not found' });
  if (pairing.locked) return res.status(403).json({ error: 'Pairing is locked' });
  const match = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(pairing.match_id);
  if (match.tournament_id !== t.id) return res.status(404).json({ error: 'Not found' });
  if (match.locked) return res.status(403).json({ error: 'Match is locked' });

  // Attribution: who entered this?
  let enteredBy = 'Admin', enteredByPlayerId = null;
  if (req.session.role === 'player') {
    const me = db.prepare(`SELECT * FROM players WHERE id = ?`).get(req.session.player_id);
    enteredBy = me.name;
    enteredByPlayerId = me.id;
    // Players may only enter scores for pairings they are part of.
    const mine = db.prepare(`SELECT 1 FROM pairing_players WHERE pairing_id = ? AND player_id = ?`)
      .get(pairing_id, me.id);
    if (!mine) return res.status(403).json({ error: 'You can only enter scores for your own group' });
  }

  const isScramble = match.format === 'scramble';
  const allowedHoles = S.segmentHoles(match.segment);
  const saveOne = db.transaction((list) => {
    for (const e of list) {
      const holeNo = Number(e.hole_no);
      if (!Number.isInteger(holeNo) || !allowedHoles.includes(holeNo)) {
        // 9-hole matches stop at hole 9; only the 18-hole scramble goes to 18.
        const lo = allowedHoles[0], hi = allowedHoles[allowedHoles.length - 1];
        throw new Error(`Hole ${e.hole_no} is not in this match (holes ${lo}–${hi})`);
      }
      // gross: null clears the hole back to "no score" — the stored row is
      // deleted, so every board/evaluation treats it as never played.
      const clearing = e.gross === null;
      const gross = clearing ? null : Number(e.gross);
      if (!clearing && (!Number.isInteger(gross) || gross < 1 || gross > 20)) {
        throw new Error(`Invalid gross score: ${e.gross}`);
      }
      if (isScramble) {
        if (e.kind !== 'team') throw new Error('Scramble entries must be kind=team');
        if (clearing) {
          db.prepare(`DELETE FROM scramble_scores WHERE pairing_id = ? AND team_id = ? AND hole_no = ?`)
            .run(pairing_id, e.id, holeNo);
        } else {
          db.prepare(`
            INSERT INTO scramble_scores (pairing_id, team_id, hole_no, gross, entered_by, entered_by_player_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(pairing_id, team_id, hole_no)
            DO UPDATE SET gross = excluded.gross, entered_by = excluded.entered_by,
                          entered_by_player_id = excluded.entered_by_player_id, updated_at = datetime('now')
          `).run(pairing_id, e.id, holeNo, gross, enteredBy, enteredByPlayerId);
        }
      } else {
        if (e.kind !== 'player') throw new Error('Entries must be kind=player for this match');
        // The scored player must belong to this pairing.
        const inPairing = db.prepare(`SELECT 1 FROM pairing_players WHERE pairing_id = ? AND player_id = ?`)
          .get(pairing_id, e.id);
        if (!inPairing) throw new Error(`Player ${e.id} is not in this pairing`);
        if (clearing) {
          db.prepare(`DELETE FROM hole_scores WHERE pairing_id = ? AND player_id = ? AND hole_no = ?`)
            .run(pairing_id, e.id, holeNo);
        } else {
          db.prepare(`
            INSERT INTO hole_scores (pairing_id, player_id, hole_no, gross, entered_by, entered_by_player_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(pairing_id, player_id, hole_no)
            DO UPDATE SET gross = excluded.gross, entered_by = excluded.entered_by,
                          entered_by_player_id = excluded.entered_by_player_id, updated_at = datetime('now')
          `).run(pairing_id, e.id, holeNo, gross, enteredBy, enteredByPlayerId);
        }
      }
    }
  });

  try {
    saveOne(entries);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Return the refreshed evaluation so the client can update immediately,
  // and push to every other connected client over the WebSocket.
  const course = LB.getCourse(pairing.course_id);
  const evaluation = isScramble
    ? LB.evaluateScramblePairing(pairing, course)
    : LB.evaluatePairing(pairing, match, course);
  const broadcast = req.app.locals.broadcast;
  if (broadcast) broadcast({ type: 'scores_updated', pairing_id, match_no: match.match_no });
  res.json({ ok: true, evaluation, entered_by: enteredBy });
});

// ------------------------------------------------------------ finalize

/**
 * POST /api/pairings/:id/finalize — scorer confirms the scores.
 * Powers the "Confirm scores" popup (explicit exception to the no-popups
 * rule): shown when every hole is scored for every player in the group.
 * Verifies completeness, then locks the pairing — no further score edits
 * except by admin (PUT /api/admin/pairings/:id with {locked:false}).
 */
router.post('/pairings/:id/finalize', auth.requireScorer, (req, res) => {
  const t = currentTournament();
  const pairing = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(req.params.id);
  if (!pairing) return res.status(404).json({ error: 'Pairing not found' });
  if (pairing.locked) return res.status(403).json({ error: 'Pairing is already finalized' });
  const match = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(pairing.match_id);
  if (match.tournament_id !== t.id) return res.status(404).json({ error: 'Not found' });
  if (match.locked) return res.status(403).json({ error: 'Match is locked' });

  if (req.session.role === 'player') {
    const mine = db.prepare(`SELECT 1 FROM pairing_players WHERE pairing_id = ? AND player_id = ?`)
      .get(pairing.id, req.session.player_id);
    if (!mine) return res.status(403).json({ error: 'You can only finalize your own group' });
  }

  // Completeness: every hole scored for every player (9 for 9-hole matches,
  // 18 for the scramble).
  const missing = [];
  if (match.format === 'scramble') {
    const have = new Set(
      db.prepare(`SELECT hole_no FROM scramble_scores WHERE pairing_id = ?`)
        .all(pairing.id).map(s => s.hole_no)
    );
    for (let h = 1; h <= 18; h++) if (!have.has(h)) missing.push({ hole: h });
  } else {
    const members = LB.getPairingPlayers(pairing.id);
    const holes = S.segmentHoles(match.segment);
    const have = new Set(
      db.prepare(`SELECT player_id, hole_no FROM hole_scores WHERE pairing_id = ?`)
        .all(pairing.id).map(s => `${s.player_id}:${s.hole_no}`)
    );
    for (const pl of members) {
      for (const h of holes) {
        if (!have.has(`${pl.id}:${h}`)) missing.push({ player: pl.name, hole: h });
      }
    }
  }
  if (missing.length) {
    return res.status(400).json({ error: 'Scores incomplete — all holes must be scored first', missing });
  }

  db.prepare(`UPDATE pairings SET locked = 1 WHERE id = ?`).run(pairing.id);

  const course = LB.getCourse(pairing.course_id);
  const evaluation = match.format === 'scramble'
    ? LB.evaluateScramblePairing(pairing, course)
    : LB.evaluatePairing(pairing, match, course);

  const broadcast = req.app.locals.broadcast;
  if (broadcast) broadcast({ type: 'tournament_updated', pairing_id: pairing.id, match_no: match.match_no });

  res.json({ ok: true, pairing_id: pairing.id, match_no: match.match_no, evaluation });
});

module.exports = router;
