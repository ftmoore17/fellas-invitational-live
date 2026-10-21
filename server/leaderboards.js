/**
 * Leaderboard computation — builds every read model from raw scores.
 *
 *  - Master scoreboard: per team, per match {mp, sf} (+ pts for M3), totals,
 *    standings with "X back". MP populates ONLY when a match is final.
 *  - Per-match low-net boards: pairs (M1/2/4/5), teams (M3), individuals (M6/7).
 *  - Weekend low-net individuals (M1,2,4,5,6,7 only — scramble excluded),
 *    with tier filter and gross+net totals.
 *  - Schedule + match detail with live match-play status and hole strips.
 * Tiebreakers (Trice, 2026-10-13):
 *  - Team standings: tied on total → higher Stableford (sfTotal) ranks higher.
 *  - Match Low Net boards: tied on net → higher Stableford ranks higher
 *    (pairs M1/2/4/5, individuals M6/7). Scramble (M3) has no Stableford;
 *    ties there use the USGA scorecard playoff, same as the points prize.
 */
'use strict';

const db = require('./db');
const S = require('./scoring');

// ---------------------------------------------------------------- helpers

// Display-only course name: stored pairing labels carry the segment suffix
// ("Love Front", "Dye Back") because the segment decides which nine is
// played, but users just see the course ("Love", "Dye"). Storage, keys, and
// segment/matching logic are untouched — this only trims emitted labels.
function displayCourseName(label) {
  if (label == null) return label;
  return String(label).replace(/\s+(Front|Back)\s*$/, '');
}

function getTournament(id) {
  return db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id);
}

function getTeams(tournamentId) {
  return db.prepare(`SELECT * FROM teams WHERE tournament_id = ? ORDER BY sort_order`).all(tournamentId);
}

function getPlayers(tournamentId) {
  return db.prepare(`SELECT p.*, t.color AS team_color FROM players p LEFT JOIN teams t ON t.id = p.team_id WHERE p.tournament_id = ?`).all(tournamentId);
}

function getMatches(tournamentId) {
  return db.prepare(`SELECT * FROM matches WHERE tournament_id = ? ORDER BY match_no`).all(tournamentId);
}

function getCourse(courseId) {
  if (!courseId) return null;
  return db.prepare(`SELECT * FROM courses WHERE id = ?`).get(courseId);
}

function holesMeta(course) {
  if (!course || !course.holes_json) return null;
  try {
    const arr = JSON.parse(course.holes_json);
    return arr.length === 18 ? arr : null;
  } catch { return null; }
}

/** Player's 18-hole course handicap on Black tees for a course. */
function playerCH(player, course) {
  return S.courseHandicap(player.ghin_index, course.black_slope, course.black_rating, course.black_par);
}

function getPairings(matchId) {
  return db.prepare(`SELECT * FROM pairings WHERE match_id = ? ORDER BY tee_time`).all(matchId);
}

function getPairingPlayers(pairingId) {
  return db.prepare(`
    SELECT pp.side, p.* FROM pairing_players pp
    JOIN players p ON p.id = pp.player_id
    WHERE pp.pairing_id = ? ORDER BY pp.side, p.name
  `).all(pairingId);
}

function getHoleScores(pairingId) {
  return db.prepare(`SELECT * FROM hole_scores WHERE pairing_id = ?`).all(pairingId);
}

function getScrambleScores(pairingId) {
  return db.prepare(`SELECT * FROM scramble_scores WHERE pairing_id = ?`).all(pairingId);
}

/** Map(playerId -> Map(holeNo -> gross)) for a pairing. */
function grossByPlayer(pairingId) {
  const map = new Map();
  for (const s of getHoleScores(pairingId)) {
    if (!map.has(s.player_id)) map.set(s.player_id, new Map());
    map.get(s.player_id).set(s.hole_no, s.gross);
  }
  return map;
}

// ------------------------------------------------------- pairing evaluation

/**
 * Evaluate one best-ball/singles pairing.
 * Returns { status, through, final, winner, mpA, mpB, sfA, sfB,
 *           holes: [{hole, a, b, winner}], sideA: {...}, sideB: {...} }
 * where sideX = { teamId, players: [{id, name, strokes, netTotal, sf, thru}] }.
 */
function evaluatePairing(pairing, match, course) {
  const meta = holesMeta(course);
  const holes = S.segmentHoles(match.segment);
  const pp = getPairingPlayers(pairing.id);
  const gross = grossByPlayer(pairing.id);

  const mkSide = (side, teamId) => {
    const players = pp.filter(r => r.side === side).map(r => {
      const ch18 = playerCH(r, course);
      const seg = S.playerSegmentScore(gross.get(r.id) || new Map(), meta, ch18, match.segment);
      return {
        id: r.id, name: r.name, tier: r.tier,
        strokes: seg.courseHcp,
        netTotal: seg.netTotal, grossTotal: seg.grossTotal,
        sf: seg.stableford, thru: seg.holesPlayed,
        nets: seg.nets,
      };
    });
    return { teamId, players };
  };

  const sideA = mkSide('A', pairing.side_a_team_id);
  const sideB = mkSide('B', pairing.side_b_team_id);

  const netsA = S.sideBestBallNets(sideA.players.map(p => p.nets), holes);
  const netsB = S.sideBestBallNets(sideB.players.map(p => p.nets), holes);
  const mp = S.matchPlayResult(netsA, netsB, holes);

  const sfA = sideA.players.reduce((s, p) => s + p.sf, 0);
  const sfB = sideB.players.reduce((s, p) => s + p.sf, 0);
  const mpA = S.matchPointsFor(mp.winner, 'A');
  const mpB = S.matchPointsFor(mp.winner, 'B');

  const holeResults = holes.map(h => {
    const a = netsA.get(h), b = netsB.get(h);
    return { hole: h, a, b, winner: a == null || b == null ? null : a < b ? 'A' : b < a ? 'B' : 'H' };
  });

  return {
    pairingId: pairing.id,
    teeTime: pairing.tee_time,
    courseLabel: displayCourseName(pairing.course_label),
    unitType: pairing.unit_type,
    status: mp.status, through: mp.through, final: mp.final,
    winner: mp.winner, leader: mp.leader, closedOut: mp.closedOut,
    mpA, mpB, sfA, sfB,
    sideA, sideB,
    colorA: db.prepare('SELECT color FROM teams WHERE id = ?').get(pairing.side_a_team_id)?.color,
    colorB: db.prepare('SELECT color FROM teams WHERE id = ?').get(pairing.side_b_team_id)?.color,
    holes: holeResults,
  };
}

/**
 * Evaluate one scramble team pairing (Match 3).
 * Returns { teamId, courseId, teeTime, holes: [gross x18], total, relPar, complete, thru }.
 */
function evaluateScramblePairing(pairing, course) {
  const meta = holesMeta(course);
  const par = meta ? meta.reduce((s, h) => s + h.par, 0) : 72;
  const scores = getScrambleScores(pairing.id);
  const byHole = new Map(scores.map(s => [s.hole_no, s.gross]));
  const holes = Array.from({ length: 18 }, (_, i) => byHole.get(i + 1) ?? null);
  const played = holes.filter(v => v != null);
  const total = played.reduce((s, v) => s + v, 0);
  // Live to-par: relative to par for the holes actually played (not the full
  // 18), so partial cards show a meaningful number mid-round. For complete
  // cards this equals total - 18-hole par.
  let relPar = null;
  if (played.length) {
    if (meta) {
      let parPlayed = 0;
      holes.forEach((v, i) => { if (v != null) parPlayed += meta[i].par; });
      relPar = total - parPlayed;
    } else if (played.length === 18) {
      relPar = total - 72;
    }
  }
  return {
    pairingId: pairing.id,
    teamId: pairing.side_a_team_id,
    color: pairing.side_a_team_id
      ? db.prepare('SELECT color FROM teams WHERE id = ?').get(pairing.side_a_team_id)?.color
      : null,
    courseId: pairing.course_id,
    courseName: course ? course.name : displayCourseName(pairing.course_label),
    teeTime: pairing.tee_time,
    holes,
    total,
    relPar,
    complete: played.length === 18,
    thru: played.length,
    par,
  };
}

// ---------------------------------------------------------- master scoreboard

/**
 * Master scoreboard for a tournament.
 * Returns { teams: [{ teamId, color, place, back, total, matches: {1:{mp,sf},...,3:{pts},...} }] }
 */
function computeMasterLeaderboard(tournamentId) {
  const teams = getTeams(tournamentId);
  const matches = getMatches(tournamentId);
  const teamById = new Map(teams.map(t => [t.id, t]));

  // Team rosters for the expandable standings rows: each team's members
  // with their designated tier, in tier order (A, B, C, D).
  const tierRank = { A: 0, B: 1, C: 2, D: 3 };
  const membersByTeam = new Map();
  for (const p of getPlayers(tournamentId)) {
    if (!membersByTeam.has(p.team_id)) membersByTeam.set(p.team_id, []);
    membersByTeam.get(p.team_id).push({ name: p.name, tier: p.tier || null });
  }
  for (const list of membersByTeam.values()) {
    list.sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9)
      || String(a.name).localeCompare(String(b.name)));
  }

  const rows = teams.map(t => ({
    teamId: t.id, color: t.color, total: 0, sfTotal: 0,
    matches: {}, members: membersByTeam.get(t.id) || [],
  }));
  const rowByTeam = new Map(rows.map(r => [r.teamId, r]));

  for (const m of matches) {
    const pairings = getPairings(m.id);
    if (m.format === 'scramble') {
      // Per-course points.
      const scCourses = db.prepare(`SELECT * FROM scramble_courses WHERE match_id = ?`).all(m.id);
      const scaleByCourse = new Map(scCourses.map(sc => [sc.course_id, JSON.parse(sc.points_scale)]));
      const byCourse = new Map(); // courseId -> entries[]
      for (const p of pairings) {
        const course = getCourse(p.course_id);
        const ev = evaluateScramblePairing(p, course);
        if (!byCourse.has(p.course_id)) byCourse.set(p.course_id, []);
        byCourse.get(p.course_id).push({ teamId: ev.teamId, holes: ev.holes, complete: ev.complete });
      }
      for (const [courseId, entries] of byCourse) {
        const scale = scaleByCourse.get(courseId) || [];
        const pts = S.scrambleCoursePoints(entries, scale);
        for (const [teamId, points] of pts) {
          const row = rowByTeam.get(teamId);
          if (row) {
            row.matches[m.match_no] = { pts: points };
            row.total += points;
          }
        }
      }
    } else {
      for (const p of pairings) {
        const course = getCourse(p.course_id);
        if (!course) continue;
        const ev = evaluatePairing(p, m, course);
        for (const [side, teamId, mp, sf] of [['A', p.side_a_team_id, ev.mpA, ev.sfA], ['B', p.side_b_team_id, ev.mpB, ev.sfB]]) {
          if (!teamId) continue;
          const row = rowByTeam.get(teamId);
          if (!row) continue;
          const cell = row.matches[m.match_no] || (row.matches[m.match_no] = { mp: 0, sf: 0, hasFinal: false });
          // MP counts as soon as THAT pairing is final; a team's cell sums
          // its completed pairings. Cell shows a dash until at least one
          // of the team's pairings in the match is final.
          if (mp != null) { cell.mp += mp; cell.hasFinal = true; }
          cell.sf += sf;
        }
      }
      // Total = completed match points + live Stableford.
      for (const row of rows) {
        const cell = row.matches[m.match_no];
        if (!cell) continue;
        row.total += cell.sf + cell.mp;
        row.sfTotal += cell.sf;
        cell.mp = cell.hasFinal ? cell.mp : null;
        delete cell.hasFinal;
      }
    }
  }

  rows.sort((a, b) => b.total - a.total || b.sfTotal - a.sfTotal);
  const leader = rows.length ? rows[0].total : 0;
  rows.forEach((r, i) => {
    r.place = i + 1;
    r.back = leader - r.total;
  });
  return { teams: rows };
}

// ------------------------------------------------------------ per-match board

/**
 * Low-net board for one match.
 * M1/2/4/5 → pairs by best-ball net. M3 → teams by score vs par (overall).
 * M6/7 → individuals by net.
 * Every board is labeled with the nine it covers (front/back/full);
 * a player's 9-hole net is always computed on holes 1-9 or 10-18 per the
 * match's segment, regardless of starting tee / play order.
 * Each row carries a live `toPar` (net vs par for holes played; gross vs
 * par for scramble), updating as scores are entered.
 */
function computeMatchBoard(tournamentId, matchNo) {
  const m = db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND match_no = ?`).get(tournamentId, matchNo);
  if (!m) return null;
  const teams = new Map(getTeams(tournamentId).map(t => [t.id, t.color]));
  const pairings = getPairings(m.id);

  if (m.format === 'scramble') {
    const rows = [];
    for (const p of pairings) {
      const course = getCourse(p.course_id);
      const ev = evaluateScramblePairing(p, course);
      const meta = holesMeta(course);
      rows.push({
        teamId: ev.teamId, color: teams.get(ev.teamId),
        course: ev.courseName, teeTime: ev.teeTime,
        total: ev.thru ? ev.total : null, toPar: ev.relPar,
        thru: ev.thru, complete: ev.complete,
        // 18-hole gross array (null = unplayed) — powers the expandable scorecard
        holes: ev.holes,
        // Per-hole pars for the scorecard chips (null when no hole data).
        pars: meta ? meta.map(h => h.par) : null,
      });
    }
    // Rank by score relative to par (live to-par); ties broken by USGA
    // scorecard playoff (scramble has no Stableford — same tiebreaker as
    // the points prize).
    rows.sort((a, b) => {
      const d = (a.toPar == null ? 99 : a.toPar) - (b.toPar == null ? 99 : b.toPar);
      if (d !== 0) return d;
      return S.scorecardPlayoff(a.holes, b.holes);
    });
    return { matchNo, format: 'scramble', nine: m.segment, nineLabel: nineLabel(m.segment), rows };
  }

  if (m.format === 'singles') {
    const rows = [];
    for (const p of pairings) {
      const course = getCourse(p.course_id);
      if (!course) continue;
      const ev = evaluatePairing(p, m, course);
      const meta = holesMeta(course);
      const holes = S.segmentHoles(m.segment);
      const gross = grossByPlayer(p.id);
      for (const side of [ev.sideA, ev.sideB]) {
        for (const pl of side.players) {
          // Live to-par over the player's scored holes.
          let toPar = 0;
          for (const h of holes) {
            const n = pl.nets.get(h);
            if (n == null || !meta) continue;
            toPar += n - meta[h - 1].par;
          }
          // Hole-by-hole detail for the expandable board row.
          const gmap = gross.get(pl.id) || new Map();
          const detail = holes.map(h => ({
            hole: h,
            par: meta ? meta[h - 1].par : null,
            gross: gmap.get(h) ?? null,
            net: pl.nets.get(h) ?? null,
          }));
          rows.push({
            playerId: pl.id, name: pl.name, tier: pl.tier,
            color: teams.get(side.teamId), teamId: side.teamId,
            strokes: pl.strokes, net: pl.thru ? pl.netTotal : null,
            toPar: pl.thru ? toPar : null,
            thru: pl.thru, sf: pl.sf,
            detail,
          });
        }
      }
    }
    rows.sort((a, b) => (a.net == null ? 999 : a.net) - (b.net == null ? 999 : b.net)
      || b.sf - a.sf); // net tie → higher Stableford ranks higher
    return { matchNo, format: 'singles', nine: m.segment, nineLabel: nineLabel(m.segment), rows };
  }

  // best ball pairs
  const rows = [];
  for (const p of pairings) {
    const course = getCourse(p.course_id);
    if (!course) continue;
    const ev = evaluatePairing(p, m, course);
    const meta = holesMeta(course);
    const holes = S.segmentHoles(m.segment);
    const gross = grossByPlayer(p.id);
    for (const [side, key] of [[ev.sideA, 'A'], [ev.sideB, 'B']]) {
      const nets = S.sideBestBallNets(side.players.map(pl => pl.nets), holes);
      let net = 0, toPar = 0, thru = 0;
      for (const h of holes) {
        const n = nets.get(h);
        if (n == null) break;
        net += n; thru++;
        if (meta) toPar += n - meta[h - 1].par;
      }
      // Hole-by-hole detail per player for the expandable board row.
      const detail = side.players.map(pl => {
        const gmap = gross.get(pl.id) || new Map();
        return {
          name: pl.name, strokes: pl.strokes,
          holes: holes.map(h => ({
            hole: h,
            par: meta ? meta[h - 1].par : null,
            gross: gmap.get(h) ?? null,
            net: pl.nets.get(h) ?? null,
          })),
        };
      });
      rows.push({
        teamId: side.teamId, color: teams.get(side.teamId),
        players: side.players.map(pl => ({ id: pl.id, name: pl.name, strokes: pl.strokes })),
        net: thru ? net : null, toPar: thru ? toPar : null, thru,
        sf: side.players.reduce((s, pl) => s + pl.sf, 0),
        detail,
      });
    }
  }
  rows.sort((a, b) => (a.net == null ? 999 : a.net) - (b.net == null ? 999 : b.net)
    || b.sf - a.sf); // net tie → higher Stableford ranks higher
  return { matchNo, format: 'bestball', nine: m.segment, nineLabel: nineLabel(m.segment), rows };
}

/** Display label for a segment's nine. */
function nineLabel(segment) {
  return segment === 'front' ? 'Front 9' : segment === 'back' ? 'Back 9' : 'Full 18';
}

/**
 * One player's own gross/net/Stableford aggregate for a single match
 * (across their pairings in that match). Shared by the weekend and
 * per-nine low-net boards.
 */
function playerMatchAggregate(playerId, match) {
  const player = db.prepare(`SELECT * FROM players WHERE id = ?`).get(playerId);
  let gross = 0, net = 0, sf = 0, holes = 0, toPar = 0;
  const pps = db.prepare(`
    SELECT pp.pairing_id FROM pairing_players pp
    JOIN pairings p ON p.id = pp.pairing_id
    WHERE pp.player_id = ? AND p.match_id = ?
  `).all(playerId, match.id);
  for (const { pairing_id } of pps) {
    const pairing = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(pairing_id);
    const course = getCourse(pairing.course_id);
    if (!course) continue;
    const meta = holesMeta(course);
    if (!meta) continue;
    const grossMap = new Map(
      getHoleScores(pairing_id).filter(s => s.player_id === playerId).map(s => [s.hole_no, s.gross])
    );
    const seg = S.playerSegmentScore(grossMap, meta, playerCH(player, course), match.segment);
    gross += seg.grossTotal; net += seg.netTotal; sf += seg.stableford; holes += seg.holesPlayed;
    for (const [h, n] of seg.nets) {
      if (n != null) toPar += n - meta[h - 1].par;
    }
  }
  return { gross, net, sf, holes, toPar };
}

/**
 * Admin score export — every player's individual gross and net scores,
 * broken down by course (Trice, 2026-10-13).
 * Per (player, course, hole) the latest entered score wins.
 * Net per hole uses the same handicap logic as the match it was scored in.
 * Scramble excluded (team scores, no handicaps).
 */
function computeScoreExport(tournamentId) {
  const t = getTournament(tournamentId);
  const players = getPlayers(tournamentId);
  const courses = db.prepare(`SELECT * FROM courses WHERE tournament_id = ? ORDER BY name`).all(tournamentId);
  const matches = getMatches(tournamentId);

  const rows = players.map(pl => {
    const perCourse = {}; // courseName -> { courseHandicap, holes: {holeNo: {...}} }
    for (const m of matches) {
      if (m.format === 'scramble') continue;
      const pps = db.prepare(`
        SELECT pp.pairing_id FROM pairing_players pp
        JOIN pairings p ON p.id = pp.pairing_id
        WHERE pp.player_id = ? AND p.match_id = ?
      `).all(pl.id, m.id);
      for (const { pairing_id } of pps) {
        const pairing = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(pairing_id);
        const course = getCourse(pairing.course_id);
        if (!course) continue;
        const meta = holesMeta(course);
        if (!meta) continue;
        const scoreRows = getHoleScores(pairing_id).filter(s => s.player_id === pl.id);
        if (!scoreRows.length) continue;
        const ch18 = playerCH(pl, course);
        const grossMap = new Map(scoreRows.map(s => [s.hole_no, s.gross]));
        const seg = S.playerSegmentScore(grossMap, meta, ch18, m.segment);
        if (!perCourse[course.name]) perCourse[course.name] = { courseHandicap: ch18, holes: {} };
        const bucket = perCourse[course.name].holes;
        const byHole = new Map(scoreRows.map(s => [s.hole_no, s]));
        for (const h of S.segmentHoles(m.segment)) {
          const sr = byHole.get(h);
          if (!sr) continue;
          const prev = bucket[h];
          if (!prev || sr.updated_at >= prev.updatedAt) {
            bucket[h] = {
              hole: h, gross: sr.gross, net: seg.nets.get(h),
              matchNo: m.match_no, matchLabel: m.label,
              enteredBy: sr.entered_by, updatedAt: sr.updated_at,
            };
          }
        }
      }
    }
    const courseData = {};
    for (const [cname, c] of Object.entries(perCourse)) {
      const holes = Object.values(c.holes).sort((a, b) => a.hole - b.hole);
      courseData[cname] = {
        courseHandicap: c.courseHandicap,
        holes,
        grossTotal: holes.reduce((s, x) => s + x.gross, 0),
        netTotal: holes.reduce((s, x) => s + (x.net == null ? 0 : x.net), 0),
        thru: holes.length,
      };
    }
    return {
      playerId: pl.id, name: pl.name, team: pl.team_color, teamId: pl.team_id,
      tier: pl.tier, ghin: pl.ghin_index,
      courses: courseData,
    };
  });

  rows.sort((a, b) => (a.team || '').localeCompare(b.team || '') || a.name.localeCompare(b.name));

  return {
    tournament: { id: t.id, name: t.name, year: t.year },
    courses: courses.map(c => c.name),
    players: rows,
  };
}

/**
 * CSV rendering of the score export: one row per player per course
 * (only courses where the player has scores).
 */
function scoreExportCSV(data) {
  const esc = (v) => {
    if (v == null || v === '') return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Player', 'Team', 'Tier', 'GHIN', 'Course', 'CH',
    ...Array.from({ length: 18 }, (_, i) => `H${i + 1} Gross`),
    ...Array.from({ length: 18 }, (_, i) => `H${i + 1} Net`),
    'Gross Total', 'Net Total', 'Thru'];
  const lines = [header.map(esc).join(',')];
  for (const p of data.players) {
    for (const cname of data.courses) {
      const c = p.courses[cname];
      if (!c || !c.holes.length) continue;
      const byHole = new Map(c.holes.map(h => [h.hole, h]));
      const gross = [], net = [];
      for (let h = 1; h <= 18; h++) {
        const x = byHole.get(h);
        gross.push(x ? x.gross : '');
        net.push(x && x.net != null ? x.net : '');
      }
      lines.push([
        p.name, p.team, p.tier, p.ghin, cname, c.courseHandicap,
        ...gross, ...net, c.grossTotal, c.netTotal, c.thru,
      ].map(esc).join(','));
    }
  }
  return lines.join('\n');
}

/**
 * Per-nine Low Net board — "Front 9 Low Net" / "Back 9 Low Net" (Trice, 2026-10-13).
 * Individuals, each player's own net summed across that nine's matches
 * (front: M1+M4+M6; back: M2+M5+M7 — derived from match segments, so it
 * adapts if the format ever changes). Scramble excluded.
 * Net tie → higher Stableford ranks higher.
 */
function computeNineLowNet(tournamentId, nine) {
  const players = getPlayers(tournamentId);
  const matches = getMatches(tournamentId).filter(m => m.segment === nine && m.format !== 'scramble');
  const rows = players.map(pl => {
    let grossTotal = 0, netTotal = 0, sfTotal = 0, holesPlayed = 0;
    const perMatch = {};
    for (const m of matches) {
      const agg = playerMatchAggregate(pl.id, m);
      if (agg.holes) perMatch[m.match_no] = { net: agg.net, thru: agg.holes, sf: agg.sf };
      grossTotal += agg.gross; netTotal += agg.net; sfTotal += agg.sf; holesPlayed += agg.holes;
    }
    return {
      playerId: pl.id, name: pl.name, tier: pl.tier,
      color: pl.team_color, teamId: pl.team_id,
      grossTotal: holesPlayed ? grossTotal : null,
      netTotal: holesPlayed ? netTotal : null,
      sfTotal, thru: holesPlayed,
      perMatch,
    };
  });
  rows.sort((a, b) => (a.netTotal == null ? 9999 : a.netTotal) - (b.netTotal == null ? 9999 : b.netTotal)
    || b.sfTotal - a.sfTotal);
  return {
    nine, label: nine === 'front' ? 'Front 9 Low Net' : 'Back 9 Low Net',
    matches: matches.map(m => m.match_no),
    rows,
  };
}

// ---------------------------------------------------------- weekend low net

/**
 * Per-course aggregates for one player across non-scramble matches —
 * powers the Weekend Low Net expandable "what they shot on each course"
 * breakdown. Returns [{ course, gross, net, toPar, thru, sf, holes }]
 * (holes = full 18-hole scorecard detail), only courses where the
 * player has scores.
 */
function playerCourseAggregates(playerId) {
  const player = db.prepare(`SELECT * FROM players WHERE id = ?`).get(playerId);
  if (!player) return [];
  const matches = getMatches(player.tournament_id).filter(mm => mm.format !== 'scramble');
  const byCourse = new Map();
  for (const m of matches) {
    const pps = db.prepare(`
      SELECT pp.pairing_id FROM pairing_players pp
      JOIN pairings p ON p.id = pp.pairing_id
      WHERE pp.player_id = ? AND p.match_id = ?
    `).all(playerId, m.id);
    for (const { pairing_id } of pps) {
      const pairing = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(pairing_id);
      const course = getCourse(pairing.course_id);
      if (!course) continue;
      const meta = holesMeta(course);
      if (!meta) continue;
      const grossMap = new Map(
        getHoleScores(pairing_id).filter(s => s.player_id === playerId).map(s => [s.hole_no, s.gross])
      );
      if (!grossMap.size) continue;
      const seg = S.playerSegmentScore(grossMap, meta, playerCH(player, course), m.segment);
      let toPar = 0;
      for (const [h, n] of seg.nets) {
        if (n != null) toPar += n - meta[h - 1].par;
      }
      if (!byCourse.has(course.name)) {
        byCourse.set(course.name, {
          course: course.name, gross: 0, net: 0, toPar: 0, thru: 0, sf: 0,
          pars: meta.map(h => h.par), holeMap: new Map(),
        });
      }
      const a = byCourse.get(course.name);
      a.gross += seg.grossTotal; a.net += seg.netTotal; a.toPar += toPar;
      a.thru += seg.holesPlayed; a.sf += seg.stableford;
      // Per-hole scorecard detail, accumulated over the same pairings and
      // segment scores as the totals above, so the holes always reconcile
      // with this row's gross / net / to-par. (Scramble is excluded here
      // exactly as it is from the totals — Weekend Low Net counts only the
      // player's own scores from the non-scramble matches.)
      for (const h of S.segmentHoles(m.segment)) {
        const g = grossMap.get(h);
        if (g == null) continue;
        const cell = a.holeMap.get(h) || { hole: h, par: meta[h - 1].par, gross: 0, net: 0 };
        cell.gross += g;
        cell.net += seg.nets.get(h) ?? 0;
        a.holeMap.set(h, cell);
      }
    }
  }
  return [...byCourse.values()].map(a => {
    // Full 18-hole scorecard: played holes from the map, the rest blank.
    const holes = Array.from({ length: 18 }, (_, i) => {
      const h = i + 1;
      return a.holeMap.get(h) || { hole: h, par: a.pars[i], gross: null, net: null };
    });
    const { pars, holeMap, ...rest } = a;
    return { ...rest, holes };
  });
}

/**
 * Weekend low-net individuals: each player's OWN net across M1,2,4,5,6,7
 * (scramble excluded). tier = 'A'|'B'|'C'|'D'|null (all).
 * Sorted by TO PAR ascending (most under par first) — Trice, 2026-10-13.
 * To-par tie → higher Stableford ranks higher.
 */
function computeWeekendLowNet(tournamentId, tier = null) {
  const players = getPlayers(tournamentId).filter(p => !tier || p.tier === tier);
  const matches = getMatches(tournamentId).filter(m => m.format !== 'scramble');
  const rows = [];

  for (const pl of players) {
    let grossTotal = 0, netTotal = 0, sfTotal = 0, toParTotal = 0, holesPlayed = 0;
    for (const m of matches) {
      const agg = playerMatchAggregate(pl.id, m);
      grossTotal += agg.gross;
      netTotal += agg.net;
      sfTotal += agg.sf;
      toParTotal += agg.toPar;
      holesPlayed += agg.holes;
    }
    rows.push({
      playerId: pl.id, name: pl.name, tier: pl.tier,
      color: pl.team_color, teamId: pl.team_id,
      grossTotal: holesPlayed ? grossTotal : null,
      netTotal: holesPlayed ? netTotal : null,
      toPar: holesPlayed ? toParTotal : null,
      sfTotal,
      thru: holesPlayed,
      // Per-course breakdown for the expandable row.
      courses: playerCourseAggregates(pl.id),
    });
  }
  rows.sort((a, b) => (a.toPar == null ? 9999 : a.toPar) - (b.toPar == null ? 9999 : b.toPar)
    || b.sfTotal - a.sfTotal);
  return { tier: tier || 'ALL', rows };
}

// ----------------------------------------------------------------- schedule

/**
 * Schedule: every match with pairings. When playerId is given, that player's
 * pairings are flagged (own: true) for highlighting.
 */
function getSchedule(tournamentId, playerId = null) {
  const teams = new Map(getTeams(tournamentId).map(t => [t.id, t.color]));
  const matches = getMatches(tournamentId);
  return matches.map(m => {
    const pairings = getPairings(m.id).map(p => {
      const course = getCourse(p.course_id);
      const pps = getPairingPlayers(p.id);
      const mkSide = (side) => ({
        teamId: side === 'A' ? p.side_a_team_id : p.side_b_team_id,
        color: teams.get(side === 'A' ? p.side_a_team_id : p.side_b_team_id),
        players: pps.filter(r => r.side === side).map(r => {
          const ch = course ? playerCH(r, course) : null;
          return {
            id: r.id, name: r.name, tier: r.tier,
            strokes: m.format === 'scramble' ? null : ch,
            own: playerId != null && r.id === playerId,
          };
        }),
      });
      const own = playerId != null && pps.some(r => r.id === playerId);
      if (m.format === 'scramble') {
        return {
          id: p.id, teeTime: p.tee_time, courseLabel: course ? course.name : displayCourseName(p.course_label),
          unitType: 'team',
          team: { teamId: p.side_a_team_id, color: teams.get(p.side_a_team_id) },
          players: pps.map(r => ({ id: r.id, name: r.name, own: playerId != null && r.id === playerId })),
          own,
        };
      }
      return {
        id: p.id, teeTime: p.tee_time,
        courseLabel: displayCourseName(p.course_label) || (course ? course.name : null),
        unitType: p.unit_type,
        sideA: mkSide('A'), sideB: mkSide('B'),
        own,
      };
    });
    const hasPairings = pairings.length > 0;
    return {
      matchNo: m.match_no, label: m.label, day: m.day,
      format: m.format, segment: m.segment, status: m.status,
      locked: !!m.locked,
      tbd: !hasPairings,
      pairings,
    };
  });
}

// -------------------------------------------------------------- match detail

/** Full detail for one match: pairings with live status + hole strips. */
function getMatchDetail(tournamentId, matchNo) {
  const m = db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND match_no = ?`).get(tournamentId, matchNo);
  if (!m) return null;
  const teams = new Map(getTeams(tournamentId).map(t => [t.id, t.color]));
  const pairings = getPairings(m.id);

  if (m.format === 'scramble') {
    const rows = pairings.map(p => {
      const course = getCourse(p.course_id);
      const ev = evaluateScramblePairing(p, course);
      return { ...ev, color: teams.get(ev.teamId) };
    });
    return { matchNo, label: m.label, format: 'scramble', status: m.status, rows };
  }

  const rows = pairings.map(p => {
    const course = getCourse(p.course_id);
    if (!course) return { pairingId: p.id, teeTime: p.tee_time, noCourse: true };
    const ev = evaluatePairing(p, m, course);
    const colorA = teams.get(p.side_a_team_id), colorB = teams.get(p.side_b_team_id);
    return { ...ev, colorA, colorB };
  });
  return { matchNo, label: m.label, format: m.format, status: m.status, rows };
}

/**
 * The logged-in player's own groups, one per match — powers the Scoring
 * tab default (Trice, 2026-10-13): show THEIR group, not a hardcoded demo.
 * Each group carries partners/opponents, live progress, and lock state so
 * the frontend can pick the default (e.g. first incomplete) and render
 * the persistent match selector.
 */
function getPlayerGroups(tournamentId, playerId) {
  const player = db.prepare(`
    SELECT p.*, t.color AS team_color FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
    WHERE p.id = ? AND p.tournament_id = ?
  `).get(playerId, tournamentId);
  if (!player) return null;
  const matches = getMatches(tournamentId);
  const groups = [];
  for (const m of matches) {
    const pps = db.prepare(`
      SELECT pp.pairing_id, pp.side FROM pairing_players pp
      JOIN pairings p ON p.id = pp.pairing_id
      WHERE pp.player_id = ? AND p.match_id = ?
    `).all(playerId, m.id);
    for (const { pairing_id, side } of pps) {
      const pairing = db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(pairing_id);
      const course = getCourse(pairing.course_id);
      const members = getPairingPlayers(pairing_id);
      const partners = members
        .filter(x => x.side === side && x.id !== playerId)
        .map(x => ({ id: x.id, name: x.name }));
      const opponents = members
        .filter(x => x.side !== side)
        .map(x => ({ id: x.id, name: x.name, side: x.side }));
      let thru = 0, final = false, status = null;
      if (m.format === 'scramble') {
        const ev = evaluateScramblePairing(pairing, course);
        thru = ev.thru; final = ev.complete;
        status = ev.complete ? 'F' : `Thru ${ev.thru}`;
      } else if (course) {
        const ev = evaluatePairing(pairing, m, course);
        thru = ev.through; final = ev.final; status = ev.status;
      }
      groups.push({
        matchNo: m.match_no, matchLabel: m.label, day: m.day,
        pairingId: pairing_id, teeTime: pairing.tee_time,
        courseLabel: displayCourseName(pairing.course_label) || (course ? course.name : null),
        format: m.format, mySide: side,
        partners, opponents,
        thru, final, status,
        locked: !!m.locked || !!pairing.locked,
      });
    }
  }
  return {
    player: { id: player.id, name: player.name, teamId: player.team_id, team: player.team_color },
    groups,
  };
}

module.exports = {
  getTournament,
  getTeams,
  getPlayers,
  getMatches,
  getCourse,
  computeMasterLeaderboard,
  computeMatchBoard,
  computeWeekendLowNet,
  computeNineLowNet,
  nineLabel,
  computeScoreExport,
  scoreExportCSV,
  getPlayerGroups,
  getPairingPlayers,
  getSchedule,
  getMatchDetail,
  evaluatePairing,
  evaluateScramblePairing,
};
