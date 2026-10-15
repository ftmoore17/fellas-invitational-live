/**
 * Scoring engine — pure functions implementing the Fellas Invitational rules.
 *
 * Source of truth: ~/workspace/fellas-invitational-scoring/SPEC.md
 *
 * Rules:
 *  - Course handicap: HI × (Slope / 113) + (Rating − Par), rounded.
 *    For 9-hole segments the 18-hole CH is halved and rounded.
 *  - Strokes allocated by stroke index (standard: SI ≤ CH gets a stroke,
 *    second/third rounds on low-SI holes when CH > 18).
 *  - Stableford (net): birdie = 1, eagle = 3, albatross = 6, condor = 12.
 *  - Match play (9 holes): win = 10 pts, tie = 5–5, loss = 0.
 *    Match Points stay empty until the match is FINAL (all holes complete).
 *  - Scramble: no handicaps; per-course placement by finishing position
 *    with USGA scorecard playoff (last 9, last 6, last 3, hole-by-hole back
 *    from 18). Unbreakable ties split the position points evenly.
 *    Overall low-net scramble ranks by score RELATIVE TO PAR.
 */
'use strict';

/** Course handicap from GHIN index. */
function courseHandicap(ghinIndex, slope, rating, par) {
  return Math.round(ghinIndex * (slope / 113) + (rating - par));
}

/** Strokes a player gets on a hole with the given stroke index. */
function strokesOnHole(courseHcp, strokeIndex) {
  if (courseHcp <= 0) return 0;
  const fullRounds = Math.floor(courseHcp / 18);
  const remainder = courseHcp % 18;
  return fullRounds + (strokeIndex <= remainder ? 1 : 0);
}

/** Stableford points for a net score on a par-N hole. */
function stablefordPoints(net, par) {
  const under = par - net;
  if (under === 1) return 1;   // net birdie
  if (under === 2) return 3;   // net eagle
  if (under === 3) return 6;   // net albatross
  if (under >= 4) return 12;   // net condor
  return 0;
}

/** Hole numbers for a segment: front = 1..9, back = 10..18, full = 1..18. */
function segmentHoles(segment) {
  if (segment === 'front') return [1, 2, 3, 4, 5, 6, 7, 8, 9];
  if (segment === 'back') return [10, 11, 12, 13, 14, 15, 16, 17, 18];
  return Array.from({ length: 18 }, (_, i) => i + 1);
}

/**
 * Compute a player's per-hole net scores for a segment.
 * grossByHole: Map(holeNo -> gross). holesMeta: [{par, si}] x18.
 * Returns { nets: Map(holeNo -> net|null), stableford, grossTotal, netTotal, holesPlayed }.
 */
function playerSegmentScore(grossByHole, holesMeta, courseHcp18, segment) {
  const holes = segmentHoles(segment);
  // Tournament rule: strokes are given for the whole 18 (on the lowest-SI holes),
  // even when a match covers only 9 holes — never halve the handicap.
  const ch = courseHcp18;
  const nets = new Map();
  let stableford = 0, grossTotal = 0, netTotal = 0, holesPlayed = 0;
  for (const h of holes) {
    const gross = grossByHole.get(h);
    if (gross == null) { nets.set(h, null); continue; }
    const { par, si } = holesMeta[h - 1];
    const net = gross - strokesOnHole(ch, si);
    nets.set(h, net);
    stableford += stablefordPoints(net, par);
    grossTotal += gross;
    netTotal += net;
    holesPlayed++;
  }
  return { nets, stableford, grossTotal, netTotal, holesPlayed, courseHcp: ch };
}

/**
 * Best-ball net per hole for a side (min of partners' nets; null if none scored).
 */
function sideBestBallNets(playerNetsList, holes) {
  const out = new Map();
  for (const h of holes) {
    let best = null;
    for (const nets of playerNetsList) {
      const n = nets.get(h);
      if (n != null && (best == null || n < best)) best = n;
    }
    out.set(h, best);
  }
  return out;
}

/**
 * Match-play result for a 9-hole best-ball or singles pairing.
 * sideANets, sideBNets: Map(holeNo -> best-ball net or null).
 * Returns { status, through, final, winner, scoreA, scoreB }.
 *  - status: "3 Up", "A/S", ... live; final adds "F" handled by caller.
 *  - winner: 'A' | 'B' | 'T' (tie) | null (not final)
 */
function matchPlayResult(sideANets, sideBNets, holes) {
  let upA = 0;           // holes won by A minus holes won by B (live, unlocked)
  let through = 0;       // contiguous completed holes from segment start
  let contiguous = true;
  // Locked result: once lead > remaining, the match is decided and the result freezes.
  // Subsequent holes don't change the match outcome (but still count for thru, Stableford, Low Net).
  let lockedUpA = null;
  let lockedRemaining = null;
  for (const h of holes) {
    const a = sideANets.get(h), b = sideBNets.get(h);
    if (a == null || b == null) { contiguous = false; continue; }
    if (contiguous) through++;
    if (lockedUpA === null) {
      if (a < b) upA++;
      else if (b < a) upA--;
      const remaining = holes.length - through;
      if (Math.abs(upA) > remaining) {
        lockedUpA = upA;
        lockedRemaining = remaining;
      }
    }
  }
  const played = holes.filter(h => sideANets.get(h) != null && sideBNets.get(h) != null).length;
  const final = played === holes.length;

  // Use locked margin if match was decided early; otherwise live margin.
  const effUpA = lockedUpA !== null ? lockedUpA : upA;
  let status;
  if (effUpA === 0) status = 'A/S';
  else status = `${Math.abs(effUpA)} Up`;

  let winner = null;
  if (lockedUpA !== null) winner = lockedUpA > 0 ? 'A' : 'B';
  else if (final) winner = upA > 0 ? 'A' : upA < 0 ? 'B' : 'T';

  // closedOut = holes remaining when the match was locked (for "X&Y" display).
  // Null if not yet decided, or 0 if decided on the last hole (display as "X Up").
  const closedOut = lockedRemaining;

  return { status, through, final, winner, upA: effUpA, closedOut, leader: effUpA > 0 ? 'A' : effUpA < 0 ? 'B' : null };
}

/** Match points for a final result: winner 10, tie 5–5, loser 0. */
function matchPointsFor(winner, side) {
  if (!winner) return null;              // not final → dash
  if (winner === 'T') return 5;
  return winner === side ? 10 : 0;
}

/**
 * USGA scorecard playoff comparator for two teams' 18-hole gross arrays.
 * Lower is better. Returns negative if a wins, positive if b wins, 0 if tied.
 */
function scorecardPlayoff(aHoles, bHoles) {
  const sum = (arr, from, to) => arr.slice(from, to).reduce((s, v) => s + (v == null ? 99 : v), 0);
  const totalA = sum(aHoles, 0, 18), totalB = sum(bHoles, 0, 18);
  if (totalA !== totalB) return totalA - totalB;
  const back9A = sum(aHoles, 9, 18), back9B = sum(bHoles, 9, 18);
  if (back9A !== back9B) return back9A - back9B;
  const last6A = sum(aHoles, 12, 18), last6B = sum(bHoles, 12, 18);
  if (last6A !== last6B) return last6A - last6B;
  const last3A = sum(aHoles, 15, 18), last3B = sum(bHoles, 15, 18);
  if (last3A !== last3B) return last3A - last3B;
  for (let h = 17; h >= 0; h--) {
    const va = aHoles[h] == null ? 99 : aHoles[h];
    const vb = bHoles[h] == null ? 99 : bHoles[h];
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Assign scramble placement points within one course.
 * entries: [{ teamId, holes: [gross x18] (nulls allowed), complete: bool }]
 * scale: [pts1st, pts2nd, ...]
 * Only complete 18-hole cards are eligible for points.
 * Unbreakable ties split the tied positions' points evenly.
 * Returns Map(teamId -> points).
 */
function scrambleCoursePoints(entries, scale) {
  const eligible = entries.filter(e => e.complete);
  eligible.sort((a, b) => scorecardPlayoff(a.holes, b.holes));
  const points = new Map();
  for (const e of entries) points.set(e.teamId, 0);
  let pos = 0; // 0-based position index into scale
  let i = 0;
  while (i < eligible.length) {
    // find tie group
    let j = i + 1;
    while (j < eligible.length && scorecardPlayoff(eligible[i].holes, eligible[j].holes) === 0) j++;
    const groupSize = j - i;
    let pts = 0;
    for (let k = 0; k < groupSize; k++) pts += scale[pos + k] || 0;
    pts = pts / groupSize;
    for (let k = i; k < j; k++) points.set(eligible[k].teamId, pts);
    pos += groupSize;
    i = j;
  }
  return points;
}

module.exports = {
  courseHandicap,
  strokesOnHole,
  stablefordPoints,
  segmentHoles,
  playerSegmentScore,
  sideBestBallNets,
  matchPlayResult,
  matchPointsFor,
  scorecardPlayoff,
  scrambleCoursePoints,
};
