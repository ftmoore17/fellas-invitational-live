/**
 * Calcutta auction — shared board + payout logic.
 *
 * Thursday-night auction: bidders buy a percentage of each team.
 * share of team = bid amount / team total. Admin verifies Venmo
 * before entering a bid (paid flag); Venmo has no API, so the
 * verification stays a human step recorded in the app.
 *
 * Payouts: the (paid) pool is split across 1st/2nd/3rd place teams by
 * the tournament's calcutta_payouts JSON (default 50/30/20); each
 * team's prize is divided among its bidders by their share of the team.
 */
'use strict';

const db = require('./db');
const LB = require('./leaderboards');

const DEFAULT_PAYOUTS = { 1: 100, 2: 0, 3: 0 };

function getPayoutSplit(tournament) {
  try {
    const p = tournament.calcutta_payouts ? JSON.parse(tournament.calcutta_payouts) : null;
    if (p && [1, 2, 3].every(k => Number.isFinite(+p[k]))) {
      return { 1: +p[1], 2: +p[2], 3: +p[3] };
    }
  } catch { /* fall through to default */ }
  return { ...DEFAULT_PAYOUTS };
}

function getBoard(tournamentId) {
  const teams = db.prepare(
    `SELECT id, color, sort_order FROM teams WHERE tournament_id = ? ORDER BY sort_order, id`
  ).all(tournamentId);
  const bids = db.prepare(
    `SELECT b.id, b.team_id, b.amount_cents, b.paid, p.id AS player_id, p.name AS player_name
     FROM calcutta_bids b JOIN players p ON p.id = b.bidder_player_id
     WHERE b.tournament_id = ? ORDER BY p.name`
  ).all(tournamentId);

  const byTeam = new Map(teams.map(t => [t.id, []]));
  for (const b of bids) {
    if (byTeam.has(b.team_id)) byTeam.get(b.team_id).push(b);
  }

  let poolCents = 0, paidCents = 0;
  const teamRows = teams.map(t => {
    const tb = (byTeam.get(t.id) || []).sort((a, b) => b.amount_cents - a.amount_cents);
    const totalCents = tb.reduce((s, b) => s + b.amount_cents, 0);
    const paidTeamCents = tb.filter(b => b.paid).reduce((s, b) => s + b.amount_cents, 0);
    poolCents += totalCents;
    paidCents += paidTeamCents;
    return {
      id: t.id,
      color: t.color,
      total_cents: totalCents,
      paid_cents: paidTeamCents,
      bids: tb.map(b => ({
        id: b.id,
        player_id: b.player_id,
        name: b.player_name,
        amount_cents: b.amount_cents,
        pct: totalCents > 0 ? +(b.amount_cents / totalCents * 100).toFixed(1) : 0,
        paid: !!b.paid,
      })),
    };
  });

  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);
  return {
    teams: teamRows,
    pool_cents: poolCents,
    paid_cents: paidCents,
    pending_cents: poolCents - paidCents,
    payouts: getPayoutSplit(tournament),
    bid_count: bids.length,
    open: tournament.calcutta_open !== 0,
    venmo_username: tournament.venmo_username || null,
  };
}

/** Projected payouts from live standings. Place -> {team, prize, cuts[]}. */
function getPayouts(tournamentId) {
  const board = getBoard(tournamentId);
  const lb = LB.computeMasterLeaderboard(tournamentId);
  const placeTeam = new Map(lb.teams.map(r => [r.place, r]));
  const teamBids = new Map(board.teams.map(t => [t.id, t]));

  return [1, 2, 3]
    .map(place => {
      const pct = board.payouts[place] || 0;
      if (!pct) return null;
      const row = placeTeam.get(place);
      if (!row) return null;
      const prizeCents = Math.round(board.paid_cents * pct / 100);
      const team = teamBids.get(row.teamId);
      const cuts = team ? team.bids.map(b => ({
        name: b.name,
        amount_cents: b.amount_cents,
        pct: b.pct,
        cut_cents: team.total_cents > 0 ? Math.round(prizeCents * b.amount_cents / team.total_cents) : 0,
      })) : [];
      return {
        place,
        pct,
        prize_cents: prizeCents,
        team_id: row.teamId,
        color: row.color,
        cuts,
      };
    })
    .filter(Boolean);
}

/** A player bets on a team from the app. Adds to any existing bid on that
 *  team (one cell per bidder per team, like the spreadsheet). New money
 *  starts unpaid — admin flips it to paid after the Venmo comes through. */
function placeBet(tournamentId, playerId, teamId, amountCents) {
  const team = db.prepare(`SELECT id FROM teams WHERE id = ? AND tournament_id = ?`).get(teamId, tournamentId);
  const player = db.prepare(`SELECT id FROM players WHERE id = ? AND tournament_id = ?`).get(playerId, tournamentId);
  if (!team || !player) return { error: 'Team or player not found' };
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { error: 'Amount must be positive' };
  const existing = db.prepare(
    `SELECT * FROM calcutta_bids WHERE tournament_id = ? AND bidder_player_id = ? AND team_id = ?`
  ).get(tournamentId, playerId, teamId);
  if (existing) {
    db.prepare(`UPDATE calcutta_bids SET amount_cents = amount_cents + ? WHERE id = ?`).run(amountCents, existing.id);
  } else {
    db.prepare(
      `INSERT INTO calcutta_bids (tournament_id, bidder_player_id, team_id, amount_cents, paid)
       VALUES (?, ?, ?, ?, 0)`
    ).run(tournamentId, playerId, teamId, amountCents);
  }
  return { ok: true };
}

/** One player's own bids, with team colors and % of team. */
function getMyBets(tournamentId, playerId) {
  const board = getBoard(tournamentId);
  const mine = [];
  for (const t of board.teams) {
    for (const b of t.bids) {
      if (b.player_id === playerId) {
        mine.push({ team_id: t.id, color: t.color, amount_cents: b.amount_cents, pct: b.pct, paid: b.paid });
      }
    }
  }
  return mine;
}

module.exports = { getBoard, getPayouts, getPayoutSplit, placeBet, getMyBets, DEFAULT_PAYOUTS };
