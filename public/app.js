/* Fellas Invitational — Live Scoring frontend.
   Single-page app: auth gate, 5 tabs, REST + WebSocket live sync. */
'use strict';

/* ============================== helpers ============================== */

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...(opts || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

const TEAM_HEX = {
  Orange: '#e98732', Green: '#4e9b62', Blue: '#3f78bf', Red: '#ca4747',
  Purple: '#815bb1', Yellow: '#e3bc39', Navy: '#234b75', Maroon: '#863c4b',
  Teal: '#2a9b97', Coral: '#ee806e', Gray: '#8895a2', Black: '#101317',
};
const teamHex = (color) => TEAM_HEX[color] || '#64748b';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function fmtToPar(v) {
  if (v == null) return '–';
  if (v === 0) return 'E';
  return (v > 0 ? '+' : '') + v;
}
function toParClass(v) {
  if (v == null || v === 0) return '';
  return v < 0 ? 'topar-neg' : 'topar-pos';
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ============================== state ============================== */

const state = {
  me: { role: null },
  tournament: null,
  tab: 'leaderboard',
  scoring: { matchNo: null, pairingId: null, detail: null, holeIdx: 0, groups: null },
  boards: { view: 'match', matchNo: 1, tier: 'ALL' },
  admin: { section: 'players' },
  ws: null, wsTimer: null,
};

/* ============================== websocket ============================== */

function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'scores_updated' || msg.type === 'tournament_updated') {
      refreshCurrentTab();
    }
  };
  ws.onclose = () => {
    clearTimeout(state.wsTimer);
    state.wsTimer = setTimeout(connectWS, 4000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

/* ============================== auth ============================== */

async function boot() {
  try {
    state.me = await api('/api/me');
  } catch { state.me = { role: null }; }
  try {
    state.tournament = await api('/api/tournament');
  } catch { state.tournament = null; }
  if (state.me.role) {
    showMain();
  } else {
    renderAuth();
  }
  connectWS();
  $$('#tab-bar .tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

function renderAuth() {
  $('#main-view').classList.add('hidden');
  const v = $('#auth-view');
  v.classList.remove('hidden');
  v.innerHTML = `
    <div class="auth-inner">
      <div class="eyebrow">The Fellas Invitational · Live Scoring</div>
      <h1>Welcome to the Fellas</h1>
      <p class="sub">Live scores, standings, and brackets for the weekend. Pick how you're joining.</p>
      <button class="rolebtn" id="role-player"><b>⛳ I'm Playing</b><span>Claim your name with your PIN to enter scores.</span></button>
      <button class="rolebtn" id="role-spectator"><b>👀 Spectator</b><span>Follow along live with the spectator code.</span></button>
      <button class="rolebtn" id="role-admin"><b>⚙ Tournament Admin</b><span>Directors only — full control.</span></button>
      <div id="auth-form"></div>
    </div>`;
  $('#role-player').onclick = renderPlayerClaim;
  $('#role-spectator').onclick = renderSpectatorForm;
  $('#role-admin').onclick = renderAdminLogin;
}

async function renderPlayerClaim() {
  const f = $('#auth-form');
  f.innerHTML = `<div class="auth-card"><div class="center tiny">Loading players…</div></div>`;
  let players = [];
  try { players = await api('/api/players'); }
  catch { f.innerHTML = `<div class="auth-card"><div class="err">Couldn't load the roster.</div></div>`; return; }
  f.innerHTML = `
    <div class="auth-card">
      <h2 style="margin-top:0">Claim Your Player</h2>
      <div class="tiny" style="margin-bottom:8px">Tap your name, then enter the PIN Trice gave you.</div>
      <div class="playerpick" id="ppick">${players.map(p => `
        <div class="prow" data-id="${p.id}" data-name="${esc(p.name)}">
          <span class="swatch" style="background:${teamHex(p.team)}"></span>
          <span class="pname">${esc(p.name)}</span>
          <span class="pmeta">${esc(p.team || '')} · Tier ${esc(p.tier || '–')}</span>
        </div>`).join('')}</div>
      <div id="pinzone" class="hidden">
        <div class="tiny mt">PIN for <b id="pinname"></b></div>
        <input id="pin" inputmode="numeric" maxlength="8" placeholder="4-digit PIN" autocomplete="off">
        <div class="err hidden" id="pinerr"></div>
        <button class="btn primary block" id="go">Claim</button>
      </div>
    </div>`;
  let chosen = null;
  $$('#ppick .prow').forEach(r => r.onclick = () => {
    chosen = { id: r.dataset.id, name: r.dataset.name };
    $('#pinname').textContent = chosen.name;
    $('#pinzone').classList.remove('hidden');
    $('#pin').focus();
  });
  $('#go').onclick = async () => {
    const pin = $('#pin').value.trim();
    $('#pinerr').classList.add('hidden');
    try {
      await api('/api/auth/claim', { method: 'POST', body: JSON.stringify({ player_id: Number(chosen.id), pin }) });
      location.reload();
    } catch (e) { const el = $('#pinerr'); el.textContent = e.message; el.classList.remove('hidden'); }
  };
}

function renderSpectatorForm() {
  $('#auth-form').innerHTML = `
    <div class="auth-card">
      <h2 style="margin-top:0">Spectator Access</h2>
      <div class="tiny" style="margin-bottom:8px">Enter the spectator code to follow along live. View-only.</div>
      <input id="scode" placeholder="Spectator code" autocomplete="off">
      <div class="err hidden" id="serr"></div>
      <button class="btn primary block" id="sgo">Watch Live</button>
    </div>`;
  $('#sgo').onclick = async () => {
    const code = $('#scode').value.trim();
    $('#serr').classList.add('hidden');
    try {
      await api('/api/auth/spectator', { method: 'POST', body: JSON.stringify({ code }) });
      location.reload();
    } catch (e) { const el = $('#serr'); el.textContent = e.message; el.classList.remove('hidden'); }
  };
}

function renderAdminLogin() {
  $('#auth-form').innerHTML = `
    <div class="auth-card">
      <h2 style="margin-top:0">Admin Login</h2>
      <label class="f">Username</label><input id="auser" autocomplete="username">
      <label class="f">Password</label><input id="apass" type="password" autocomplete="current-password">
      <div class="err hidden" id="aerr"></div>
      <button class="btn primary block" id="ago">Log In</button>
    </div>`;
  $('#ago').onclick = async () => {
    const username = $('#auser').value.trim(), password = $('#apass').value;
    $('#aerr').classList.add('hidden');
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      location.reload();
    } catch (e) { const el = $('#aerr'); el.textContent = e.message; el.classList.remove('hidden'); }
  };
}

/* ============================== shell ============================== */

const TAB_TITLES = { leaderboard: 'Leaderboard', scoring: 'Scoring', boards: 'Boards', schedule: 'Schedule', admin: 'Admin' };

function showMain() {
  $('#auth-view').classList.add('hidden');
  $('#main-view').classList.remove('hidden');
  const chip = $('#user-chip');
  const me = state.me;
  let label = '';
  if (me.role === 'admin') label = 'Admin';
  else if (me.role === 'player' && me.player) label = esc(me.player.name);
  else if (me.role === 'spectator') label = 'Spectator';
  chip.innerHTML = `${label} <button id="logout">Log out</button>`;
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
  switchTab('leaderboard');
}

function switchTab(tab) {
  state.tab = tab;
  $$('#tab-bar .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-title').textContent = TAB_TITLES[tab];
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (!state.me.role) return;
  ({ leaderboard: renderLeaderboard, scoring: renderScoring, boards: renderBoards, schedule: renderSchedule, admin: renderAdmin })[state.tab]();
}

/* ============================== LEADERBOARD ============================== */

async function renderLeaderboard() {
  const el = $('#tab-content');
  el.innerHTML = `<div class="card center tiny">Loading leaderboard…</div>`;
  let data;
  try { data = await api('/api/leaderboard'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }

  const matchNos = [1, 2, 3, 4, 5, 6, 7];
  let html = `
    <div class="board-wrap"><table class="board">
      <thead><tr>
        <th style="text-align:left;padding-left:41px">Team</th>
        ${matchNos.map(n => n === 3 ? `<th>M3<br><span style="font-weight:400">PTS</span></th>`
          : `<th>M${n}<br><span style="font-weight:400">MP&nbsp;SF</span></th>`).join('')}
        <th>Total</th>
      </tr></thead>
      <tbody>
      ${data.teams.map(t => `
        <tr>
          <td class="teamcell">
            <span class="tname"><span class="place">${ordinal(t.place)}</span><span style="display:flex;flex-direction:column;line-height:1.25"><span style="color:${teamHex(t.color)};font-weight:700">${esc(t.color)}</span><span class="back" style="margin-left:0">${t.back === 0 ? 'Leader' : t.back + ' back'}</span></span></span>
          </td>
          ${matchNos.map(n => {
            const c = t.matches[n];
            if (!c) return `<td>–</td>`;
            if (n === 3) return `<td>${c.pts == null ? '–' : c.pts}</td>`;
            return `<td>${c.mp == null ? '–' : c.mp}&nbsp;&nbsp;${c.sf || 0}</td>`;
          }).join('')}
          <td class="total">${t.total}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <div class="legend">MP = match points · SF = Stableford${prizeLegend()}</div>
    <div class="section-title">Match Center</div>
    <div class="pillrow" id="lb-matchpills">
      ${matchNos.map(n => `<button class="mpill ${state.lbMatch === n ? 'active' : ''}" data-n="${n}">M${n}</button>`).join('')}
    </div>
    <div id="lb-pairs"><div class="card center tiny">Loading pairings…</div></div>`;

  el.innerHTML = html;
  $$('#lb-matchpills .mpill').forEach(b => b.onclick = () => {
    state.lbMatch = Number(b.dataset.n);
    $$('#lb-matchpills .mpill').forEach(x => x.classList.toggle('active', Number(x.dataset.n) === state.lbMatch));
    renderLeaderboardPairs();
  });
  if (!state.lbMatch) state.lbMatch = 1;
  renderLeaderboardPairs();
}

function prizeLegend() {
  const p = state.tournament && state.tournament.prizes;
  if (!p) return '';
  const fmt = (v) => v == null ? null : '$' + Number(v).toLocaleString();
  const parts = [];
  if (fmt(p.first)) parts.push(`1st Place ${fmt(p.first)}`);
  if (fmt(p.second)) parts.push(`2nd Place ${fmt(p.second)}`);
  return parts.length ? `<br>${parts.join(' · ')}` : '';
}

async function renderLeaderboardPairs() {
  const host = $('#lb-pairs');
  if (!host) return;
  const n = state.lbMatch || 1;
  host.innerHTML = `<div class="card center tiny">Loading pairings…</div>`;
  try {
    const m = await api(`/api/matches/${n}`).catch(() => null);
    host.innerHTML = m ? matchPairCard(m) : `<div class="card center tiny">No pairings yet.</div>`;
  } catch { host.innerHTML = `<div class="card center tiny">Couldn't load pairings.</div>`; }
}

/* Pairing card used on the Leaderboard tab (Trice wants match cards here). */
function matchPairCard(m) {
  if (!m.rows || !m.rows.length) {
    return `<div class="card"><h2>${esc(m.label)}</h2><div class="sub">${m.tbd ? 'TBD' : ''}</div></div>`;
  }
  // M3 scramble: separate by course (Norman vs Fazio), sort each by to-par
  if (m.format === 'scramble') {
    const byCourse = {};
    m.rows.forEach(row => {
      const c = row.courseName || 'TBD';
      if (!byCourse[c]) byCourse[c] = [];
      byCourse[c].push(row);
    });
    // Sort each course group by relPar ascending (nulls last)
    Object.values(byCourse).forEach(group => {
      group.sort((a, b) => {
        const ap = a.relPar == null ? 999 : a.relPar;
        const bp = b.relPar == null ? 999 : b.relPar;
        return ap - bp;
      });
    });
    const courseOrder = Object.keys(byCourse).sort();
    return `
    <div class="section-title" style="margin-top:14px">${esc(m.label)}</div>
    ${courseOrder.map(course => `
      <div class="section-title" style="margin-top:10px;font-size:0.9em;color:var(--muted)">${esc(course)}</div>
      ${byCourse[course].map(row => {
        if (row.noCourse) return `<div class="paircard"><div class="phead"><span>${esc(row.teeTime || '')}</span><span>Course TBD</span></div></div>`;
        return scrambleRowCard(row);
      }).join('')}
    `).join('')}`;
  }
  return `
    <div class="section-title" style="margin-top:14px">${esc(m.label)}</div>
    ${m.rows.map(row => {
      if (row.noCourse) return `<div class="paircard"><div class="phead"><span>${esc(row.teeTime || '')}</span><span>Course TBD</span></div></div>`;
      return pairVsCard(row, m);
    }).join('')}`;
}

function scrambleRowCard(ev) {
  return `
    <div class="paircard">
      <div class="phead"><span>${esc(ev.teeTime || '')}</span><span>${esc(ev.courseName || '')}</span></div>
      <div class="vs"><div class="side">
        <div class="tlabel" style="color:${teamHex(ev.color)}">${esc(ev.color)}</div>
        <div class="matchstatus">${ev.complete ? 'Final' : 'Thru ' + ev.thru}
          <span class="through">${ev.relPar == null ? '' : 'To par ' + fmtToPar(ev.relPar)}</span>
        </div>
      </div></div>
    </div>`;
}

function pairVsCard(ev, m) {
  // Status: "{Team} {Margin}" in team color on line 1, "Final"/"Thru X" on line 2
  const leadName = ev.leader === 'A' ? ev.colorA : ev.leader === 'B' ? ev.colorB : null;
  const leadColor = leadName ? teamHex(leadName) : '#8895a2';
  let topLine, botLine;
  if (ev.final) {
    const margin = ev.status && ev.status !== 'A/S' ? ev.status : (ev.winner && ev.winner !== 'T' ? '1 Up' : '');
    topLine = leadName && margin ? `${leadName} ${margin}` : (leadName ? `${leadName} wins` : 'Tied');
    botLine = 'Final';
  } else if (leadName && ev.status && ev.status !== 'A/S') {
    topLine = `${leadName} ${ev.status}`;
    botLine = ev.through != null ? `Thru ${ev.through}` : '';
  } else {
    topLine = 'Tied';
    botLine = ev.through != null ? `Thru ${ev.through}` : '';
  }
  const statusHtml = `<div class="matchstatus"><div style="color:${leadColor};font-weight:800;font-size:1.3em">${esc(topLine)}</div>${botLine ? `<div style="color:#8895a2;font-size:1.1em;font-weight:700">${esc(botLine)}</div>` : ''}</div>`;
  const strip = (ev.holes || []).map(h => {
    const cls = h.winner === 'A' ? 'A' : h.winner === 'B' ? 'B' : h.winner === 'H' ? 'H' : '';
    return `<div class="holepip ${cls}">${h.hole}</div>`;
  }).join('');
  const side = (s, color, align) => {
    const isRight = align === 'right';
    const labelHtml = isRight
      ? `<div class="tlabel right">${esc(color)}<span class="swatch" style="background:${teamHex(color)};margin-left:8px"></span></div>`
      : `<div class="tlabel"><span class="swatch" style="background:${teamHex(color)};margin-right:8px"></span>${esc(color)}</div>`;
    return `
    <div class="side ${align}">
      ${labelHtml}
      ${(s.players || []).map(p => `<div class="pname">${esc(p.name)}<span class="strokes">${p.strokes} STR</span></div>`).join('')}
    </div>`;
  };
  return `
    <div class="paircard">
      <div class="phead"><span>${esc(ev.teeTime || '')}</span><span>${esc(ev.courseLabel || '')}</span></div>
      ${statusHtml}
      <div class="vs">
        ${side(ev.sideA, ev.colorA, '')}
        <div class="vsbadge">VS</div>
        ${side(ev.sideB, ev.colorB, 'right')}
      </div>
      ${strip ? `<div class="holestrip">${strip}</div>` : ''}
    </div>`;
}

function describeWinner(ev) {
  if (!ev.winner || ev.winner === 'T') return 'Tied';
  const lead = ev.leader;
  return lead ? `${lead} ${ev.winner === 'A' ? 'up' : 'up'}` : 'Tied';
}

/* ============================== SCORING ============================== */

async function renderScoring() {
  const el = $('#tab-content');
  if (state.me.role === 'spectator') {
    el.innerHTML = `<div class="card"><h2>Scoring</h2><div class="sub">Spectators can't enter scores — follow the live action on the Leaderboard and Boards tabs.</div></div>`;
    return;
  }
  const s = state.scoring;
  el.innerHTML = `
    <div class="pillrow" id="score-matchpills">
      ${[1, 2, 3, 4, 5, 6, 7].map(n => `<button class="mpill" data-n="${n}">M${n}</button>`).join('')}
    </div>
    <div id="score-body"><div class="card center tiny">Loading…</div></div>`;

  $$('#score-matchpills .mpill').forEach(b => b.onclick = () => selectScoreMatch(Number(b.dataset.n)));

  // Default: logged-in player's own group (never a hardcoded demo).
  let matchNo = s.matchNo;
  if (!matchNo && state.me.role === 'player') {
    try {
      const g = await api('/api/my/groups');
      s.groups = g;
      const firstOpen = g.groups.find(x => !x.final) || g.groups[0];
      if (firstOpen) { matchNo = firstOpen.matchNo; s.pairingId = firstOpen.pairingId; }
    } catch { /* fall through */ }
  }
  selectScoreMatch(matchNo || 1);
}

async function selectScoreMatch(n) {
  const s = state.scoring;
  s.matchNo = n;
  $$('#score-matchpills .mpill').forEach(b => b.classList.toggle('active', Number(b.dataset.n) === n));
  const body = $('#score-body');
  body.innerHTML = `<div class="card center tiny">Loading match…</div>`;

  // Pairings for this match.
  let detail;
  try { detail = await api(`/api/matches/${n}`); }
  catch (e) { body.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  if (!detail.rows || !detail.rows.length) {
    body.innerHTML = `<div class="card"><h2>${esc(detail.label)}</h2><div class="sub">Pairings TBD.</div></div>`;
    return;
  }

  // Pick pairing: player's own group if available, else first (admin picks).
  let pairingId = null;
  if (state.me.role === 'player' && s.groups) {
    const g = s.groups.groups.find(x => x.matchNo === n && (!s.pairingId || x.pairingId === s.pairingId))
      || s.groups.groups.find(x => x.matchNo === n);
    if (g) pairingId = g.pairingId;
  }
  if (!pairingId) {
    // Admin (or player without a group in this match): choose a pairing.
    body.innerHTML = `
      <div class="card"><h2>${esc(detail.label)}</h2><div class="sub">Choose a group to score:</div>
      ${detail.rows.map(r => {
        const pid = r.pairingId;
        const label = detail.format === 'scramble'
          ? `${esc(r.color || '')} · ${esc(r.teeTime || '')}`
          : `${esc(r.colorA || '')} vs ${esc(r.colorB || '')} · ${esc(r.teeTime || '')}`;
        return `<button class="btn secondary block" data-pid="${pid}">${label}</button>`;
      }).join('')}</div>`;
    $$('#score-body [data-pid]').forEach(b => b.onclick = () => loadPairingScoring(Number(b.dataset.pid)));
    return;
  }
  loadPairingScoring(pairingId);
}

async function loadPairingScoring(pairingId) {
  const s = state.scoring;
  s.pairingId = pairingId;
  const body = $('#score-body');
  body.innerHTML = `<div class="card center tiny">Loading scorecard…</div>`;
  let d;
  try { d = await api(`/api/pairings/${pairingId}`); }
  catch (e) { body.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  s.detail = d;
  s.holeIdx = 0;
  // Start at first unscored hole.
  const holes = (d.holes || []).map(h => h.hole);
  const scoredHoles = new Set();
  Object.values(d.scores || {}).forEach(m => Object.keys(m).forEach(h => scoredHoles.add(Number(h))));
  const firstOpen = holes.find(h => !scoredHoles.has(h));
  if (firstOpen != null) s.holeIdx = holes.indexOf(firstOpen);
  renderScorecard();
}

function scoringPlayers() {
  const d = state.scoring.detail;
  if (!d) return [];
  if (d.format === 'scramble') {
    return [{ id: d.evaluation.teamId, name: d.evaluation.courseName || 'Team', team: true }];
  }
  const ev = d.evaluation;
  return [...(ev.sideA.players || []), ...(ev.sideB.players || [])];
}

function isGroupComplete() {
  const d = state.scoring.detail;
  if (!d || !d.holes) return false;
  const holes = d.holes.map(h => h.hole);
  const players = scoringPlayers();
  for (const p of players) {
    const sm = (d.scores || {})[p.id] || {};
    for (const h of holes) if (sm[h] == null) return false;
  }
  return true;
}

function renderScorecard() {
  const s = state.scoring, d = s.detail;
  const body = $('#score-body');
  if (!d) return;
  const ev = d.evaluation;
  const holes = d.holes || [];
  const cur = holes[s.holeIdx];
  const isScr = d.format === 'scramble';

  // Status line — centered stack: leading team name, margin, through/final — all in team color (gray if tied).
  let statusHtml = '';
  if (!isScr) {
    const leadName = ev.leader === 'A' ? ev.colorA : ev.leader === 'B' ? ev.colorB : null;
    const leadColor = leadName ? teamHex(leadName) : '#8895a2';
    // Middle: "Yellow 1 Up", "Yellow 2&1", or "Tied"
    let marginText = 'Tied';
    if (leadName) {
      const margin = ev.status && ev.status !== 'A/S' ? ev.status : '';
      marginText = margin ? `${leadName} ${margin}` : leadName;
    }
    // Bottom: "Final" or "Thru X" (not both)
    const throughText = ev.final ? 'Final' : (ev.through ? `Thru ${ev.through}` : 'Not started');
    statusHtml = `
      <div class="score-status">
        <div class="status-margin" style="color:${leadColor}">${esc(marginText)}</div>
        <div class="status-through" style="color:#8895a2">${esc(throughText)}</div>
      </div>`;
  } else {
    statusHtml = `
      <div class="score-status">
        <div class="lead">${esc(ev.courseName || '')}</div>
        <div class="detail">${ev.complete ? 'Final' : 'Thru ' + ev.thru} ${ev.relPar == null ? '' : '· To par ' + fmtToPar(ev.relPar)}</div>
      </div>`;
  }

  // Hole selector (bounded by match segment — stops at 9 for 9-hole matches).
  const holeBtns = holes.map((h, i) => {
    const scored = scoringPlayers().some(p => ((s.detail.scores || {})[p.id] || {})[h.hole] != null);
    return `<button class="hbtn ${i === s.holeIdx ? 'active' : ''} ${scored ? 'scored' : ''}" data-i="${i}">${h.hole}</button>`;
  }).join('');

  // Player cards for current hole.
  // Per-hole strokes: floor(courseHcp/18) + (1 if stroke index <= courseHcp % 18).
  const strokesOnHole = (hcp, si) => Math.floor(hcp / 18) + (si <= (hcp % 18) ? 1 : 0);
  const sideAIds = new Set(((ev.sideA && ev.sideA.players) || []).map(x => x.id));
  const cards = scoringPlayers().map(p => {
    const curGross = ((d.scores || {})[p.id] || {})[cur.hole];
    const pl = !isScr ? [...ev.sideA.players, ...ev.sideB.players].find(x => x.id === p.id) : null;
    const hcp = pl ? (pl.strokes || 0) : 0;
    const holeStrokes = strokesOnHole(hcp, cur.si);
    const net = curGross != null ? curGross - holeStrokes : null;
    const strokesNote = `${holeStrokes} on this hole`;
    // Team color: prefer player's own team, fall back to side A/B
    const teamColor = p.team || (sideAIds.has(p.id) ? ev.colorA : ev.colorB);
    return `
      <div class="scorer-card" data-pid="${p.id}" data-hs="${holeStrokes}">
        <div class="phead">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="swatch" style="background:${teamHex(teamColor)}"></span>
            <div>
              <div class="pname">${esc(p.name)}<span class="strokes">${hcp} STR</span></div>
              ${isScr ? '' : `<div class="strokes-note">${esc(strokesNote)}</div>`}
              ${!isScr ? `<div class="netline" style="font-weight:800;font-size:1.1em;margin-top:2px;${net == null ? 'display:none' : ''}">NET <span class="netval" style="color:${teamHex(teamColor)}">${net == null ? '' : net}</span></div>` : ''}
            </div>
          </div>
          <div class="stepper">
            <button data-act="dec">−</button>
            <div class="val" data-val>${curGross == null ? '–' : curGross}</div>
            <button data-act="inc">+</button>
          </div>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    ${statusHtml}
    <div class="holeselector">${holeBtns}</div>
    <div class="curhole">
      <div class="nav">
        <button class="navbtn" id="prevhole" ${s.holeIdx === 0 ? 'disabled' : ''}>‹</button>
        <div><div class="num">${cur.hole}</div><div class="meta">Par ${cur.par} · SI ${cur.si}</div></div>
        <button class="navbtn" id="nexthole" ${s.holeIdx >= holes.length - 1 ? 'disabled' : ''}>›</button>
      </div>
    </div>
    ${cards}
    <button class="btn primary block" id="savehole">Save Hole</button>
    ${isGroupComplete() && !d.pairing.locked ? `<button class="btn gold block" id="confirmbtn">Confirm Scores</button>` : ''}
    ${d.pairing.locked ? `<div class="card center mt"><span class="lockedtag">✓ Finalized</span></div>` : ''}`;

  // Wire hole nav.
  $$('#score-body .hbtn').forEach(b => b.onclick = () => { s.holeIdx = Number(b.dataset.i); renderScorecard(); });
  $('#prevhole').onclick = () => { if (s.holeIdx > 0) { s.holeIdx--; renderScorecard(); } };
  $('#nexthole').onclick = () => { if (s.holeIdx < holes.length - 1) { s.holeIdx++; renderScorecard(); } };

  // Wire steppers (local pending state until Save).
  if (!s.pending) s.pending = {};
  $$('#score-body .scorer-card').forEach(card => {
    const pid = Number(card.dataset.pid);
    const hs = Number(card.dataset.hs || 0);
    const valEl = $('.val', card);
    const netEl = $('.netline', card);
    const netValEl = $('.netval', card);
    let v = ((d.scores || {})[pid] || {})[cur.hole];
    if (s.pending[`${pid}:${cur.hole}`] !== undefined) v = s.pending[`${pid}:${cur.hole}`];
    const paint = () => {
      valEl.textContent = v == null ? '–' : v;
      if (netEl && netValEl) {
        const n = v == null ? null : v - hs;
        if (n == null) { netEl.style.display = 'none'; }
        else { netEl.style.display = ''; netValEl.textContent = n; }
      }
    };
    paint();
    $('[data-act="dec"]', card).onclick = () => { v = v == null ? cur.par : Math.max(1, v - 1); s.pending[`${pid}:${cur.hole}`] = v; paint(); };
    $('[data-act="inc"]', card).onclick = () => { v = v == null ? cur.par : Math.min(20, v + 1); s.pending[`${pid}:${cur.hole}`] = v; paint(); };
  });

  $('#savehole').onclick = saveCurrentHole;
  const cb = $('#confirmbtn');
  if (cb) cb.onclick = showConfirmPopup;
}

async function saveCurrentHole() {
  const s = state.scoring, d = s.detail;
  const cur = (d.holes || [])[s.holeIdx];
  const entries = [];
  for (const p of scoringPlayers()) {
    const key = `${p.id}:${cur.hole}`;
    const saved = ((d.scores || {})[p.id] || {})[cur.hole];
    const v = s.pending[key] !== undefined ? s.pending[key] : saved;
    if (v != null) entries.push({ kind: d.format === 'scramble' ? 'team' : 'player', id: p.id, hole_no: cur.hole, gross: v });
  }
  if (!entries.length) return;
  try {
    const res = await api('/api/scores', { method: 'POST', body: JSON.stringify({ pairing_id: d.pairing.id, entries }) });
    s.pending = {};
    // Merge fresh evaluation + scores.
    const fresh = await api(`/api/pairings/${d.pairing.id}`);
    s.detail = fresh;
    renderScorecard();
  } catch (e) {
    alert(e.message);
  }
}

/* ---- Confirm scores popup (explicit Trice exception to no-popups) ---- */

function showConfirmPopup() {
  const d = state.scoring.detail;
  const holes = (d.holes || []).map(h => h.hole);
  const players = scoringPlayers();
  const isScr = d.format === 'scramble';
  $('#confirm-summary').innerHTML = `
    <div class="tiny" style="margin-bottom:8px">${esc(d.match.label)} — all ${holes.length} holes scored. Please review:</div>
    <table class="conftable"><thead><tr><th>${isScr ? 'Team' : 'Player'}</th>
      ${holes.map(h => `<th class="num">${h}</th>`).join('')}<th class="num">Tot</th></tr></thead>
    <tbody>${players.map(p => {
      const sm = (d.scores || {})[p.id] || {};
      const tot = holes.reduce((s, h) => s + (sm[h] || 0), 0);
      return `<tr><td>${esc(p.name)}</td>${holes.map(h => `<td class="num">${sm[h] == null ? '–' : sm[h]}</td>`).join('')}<td class="num"><b>${tot}</b></td></tr>`;
    }).join('')}</tbody></table>`;
  $('#confirm-overlay').classList.remove('hidden');
  $('#confirm-back').onclick = () => $('#confirm-overlay').classList.add('hidden');
  $('#confirm-go').onclick = async () => {
    try {
      await api(`/api/pairings/${d.pairing.id}/finalize`, { method: 'POST' });
      $('#confirm-overlay').classList.add('hidden');
      const fresh = await api(`/api/pairings/${d.pairing.id}`);
      state.scoring.detail = fresh;
      state.scoring.pending = {};
      renderScorecard();
    } catch (e) { alert(e.message); }
  };
}

/* ============================== BOARDS ============================== */

async function renderBoards() {
  const el = $('#tab-content');
  const b = state.boards;
  el.innerHTML = `
    <div class="pillrow" id="board-tabs">
      <button class="mpill ${b.view === 'match' ? 'active' : ''}" data-v="match">Match Low Net</button>
      <button class="mpill ${b.view === 'weekend' ? 'active' : ''}" data-v="weekend">Weekend Low Net</button>
    </div>
    <div id="board-sub"></div>
    <div id="board-body"><div class="card center tiny">Loading…</div></div>`;
  $$('#board-tabs .mpill').forEach(x => x.onclick = () => { state.boards.view = x.dataset.v; renderBoards(); });
  const sub = $('#board-sub');
  if (b.view === 'match') {
    sub.innerHTML = `<div class="pillrow">${[1, 2, 3, 4, 5, 6, 7].map(n =>
      `<button class="mpill ${b.matchNo === n ? 'active' : ''}" data-n="${n}">M${n}</button>`).join('')}</div>`;
    $$('#board-sub .mpill').forEach(x => x.onclick = () => { state.boards.matchNo = Number(x.dataset.n); renderBoards(); });
    renderMatchBoard();
  } else if (b.view === 'weekend') {
    sub.innerHTML = `<div class="pillrow">${['ALL', 'A', 'B', 'C', 'D'].map(t =>
      `<button class="mpill ${b.tier === t ? 'active' : ''}" data-t="${t}">${t === 'ALL' ? 'All' : 'Tier ' + t}</button>`).join('')}</div>`;
    $$('#board-sub .mpill').forEach(x => x.onclick = () => { state.boards.tier = x.dataset.t; renderBoards(); });
    renderWeekendBoard();
  } else {
    renderNineBoard(b.view);
  }
}

async function renderMatchBoard() {
  const el = $('#board-body');
  const n = state.boards.matchNo;
  let data;
  try { data = await api(`/api/boards/match/${n}`); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  const label = data.format === 'scramble' ? `Match ${n} · Team Low Net — ${esc(data.nineLabel)}`
    : data.format === 'singles' ? `Match ${n} · Individual Low Net — ${esc(data.nineLabel)}`
    : `Match ${n} · Pair Low Net — ${esc(data.nineLabel)}`;
  let html = `<div class="card"><h2>${label}</h2><div class="sub">Live · ties broken by Stableford</div></div>`;
  html += `<table class="rows"><thead><tr><th></th><th>${data.format === 'scramble' ? 'Team' : data.format === 'singles' ? 'Player' : 'Pair'}</th><th class="num">Thru</th><th class="num">To Par</th></tr></thead><tbody>`;
  data.rows.forEach((r, i) => {
    const name = data.format === 'scramble' ? r.color
      : data.format === 'singles' ? r.name
      : r.players.map(p => p.name).join(' & ');
    const color = r.color;
    html += `<tr><td class="rank">${i + 1}</td>
      <td><span class="swatch" style="background:${teamHex(color)}"></span> ${esc(name)}</td>
      <td class="num">${r.thru || '–'}</td>
      <td class="num ${toParClass(r.toPar)}">${fmtToPar(r.toPar)}</td></tr>`;
  });
  html += `</tbody></table>`;
  el.innerHTML = html;
}

async function renderWeekendBoard() {
  const el = $('#board-body');
  const tier = state.boards.tier === 'ALL' ? '' : `?tier=${state.boards.tier}`;
  let data;
  try { data = await api(`/api/boards/weekend${tier}`); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  let html = `<div class="card"><h2>Weekend Low Net ${state.boards.tier === 'ALL' ? '' : '· Tier ' + esc(state.boards.tier)}</h2></div>`;
  html += `<table class="rows"><thead><tr><th></th><th>Player</th><th class="num">Net</th><th class="num">To Par</th></tr></thead><tbody>`;
  data.rows.forEach((r, i) => {
    html += `<tr><td class="rank">${i + 1}</td>
      <td><span class="swatch" style="background:${teamHex(r.color)}"></span> ${esc(r.name)} <span class="pill">${esc(r.tier || '')}</span></td>
      <td class="num">${r.netTotal == null ? '–' : r.netTotal}</td>
      <td class="num ${toParClass(r.toPar)}">${fmtToPar(r.toPar)}</td></tr>`;
  });
  html += `</tbody></table>`;
  el.innerHTML = html;
}

async function renderNineBoard(nine) {
  const el = $('#board-body');
  let data;
  try { data = await api(`/api/boards/nine/${nine}`); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  const mlist = (data.matches || []).map(m => 'M' + m).join(' + ');
  let html = `<div class="card"><h2>${esc(data.label)}</h2><div class="sub">Individual · ${esc(mlist)} · scramble excluded</div></div>`;
  html += `<table class="rows"><thead><tr><th></th><th>Player</th><th class="num">Thru</th><th class="num">Net</th></tr></thead><tbody>`;
  data.rows.forEach((r, i) => {
    html += `<tr><td class="rank">${i + 1}</td>
      <td><span class="swatch" style="background:${teamHex(r.color)}"></span> ${esc(r.name)} <span class="pill">${esc(r.tier || '')}</span></td>
      <td class="num">${r.thru || '–'}</td>
      <td class="num">${r.netTotal == null ? '–' : r.netTotal}</td></tr>`;
  });
  html += `</tbody></table>`;
  el.innerHTML = html;
}

/* ============================== SCHEDULE ============================== */

async function renderSchedule() {
  const el = $('#tab-content');
  el.innerHTML = `<div class="card center tiny">Loading schedule…</div>`;
  let matches;
  try { matches = await api('/api/schedule'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }

  const isPlayer = state.me.role === 'player';
  const matchDay = (n) => n <= 3 ? 'Friday' : 'Saturday';
  const byNo = {};
  matches.forEach(m => { byNo[m.matchNo] = m; });

  // Simple card: Match #, tee time, course. Equal sizes, clean.
  const simpleCard = (n) => {
    const m = byNo[n];
    if (!m) return `<div class="paircard"><div style="font-weight:800">Match ${n}</div><div class="tiny">TBD</div></div>`;
    let teeTime = 'TBD', course = 'TBD';
    if (isPlayer) {
      const p = (m.pairings || []).find(p => p.own);
      if (p) { teeTime = p.teeTime || 'TBD'; course = p.courseLabel || 'TBD'; }
      else if (n >= 6) { teeTime = 'TBD'; course = 'TBD'; }
    } else {
      // For spectators/admin: show first pairing as representative, or TBD
      const p = (m.pairings || [])[0];
      if (p) { teeTime = p.teeTime || 'TBD'; course = p.courseLabel || 'TBD'; }
    }
    // M2/M5/M7: show "Following front 9" instead of TBD time. M6: TBD only.
    if ([2, 5, 7].includes(n)) {
      return `<div class="paircard" style="padding:14px 16px">
        <div style="font-weight:800;font-size:1.1em">Match ${n}</div>
        <div style="margin-top:4px;color:var(--muted)">Following front 9</div>
      </div>`;
    }
    return `<div class="paircard" style="padding:14px 16px">
      <div style="font-weight:800;font-size:1.1em">Match ${n}</div>
      <div style="margin-top:4px">${esc(teeTime)} · ${esc(course)}</div>
    </div>`;
  };

  let html = '';
  ['Friday', 'Saturday'].forEach(day => {
    const nums = [1, 2, 3, 4, 5, 6, 7].filter(n => matchDay(n) === day);
    html += `<div class="section-title" style="font-size:1.3em;font-weight:800;margin-top:16px">${day}</div>`;
    nums.forEach(n => { html += simpleCard(n); });
  });
  el.innerHTML = html || `<div class="card center tiny">No schedule yet.</div>`;
}

function schedPairCard(m, p, highlight) {
  const inner = m.format === 'scramble'
    ? `<div class="tlabel" style="color:${teamHex(p.team.color)}">${esc(p.team.color)}</div>
       <div class="tiny">${(p.players || []).map(x => esc(x.name)).join(', ')}</div>`
    : `<div class="vs">
        <div class="side"><div class="tlabel">${esc(p.sideA.color)}</div>${(p.sideA.players || []).map(x => `<div class="pname">${esc(x.name)}</div>`).join('')}</div>
        <div class="vsbadge">VS</div>
        <div class="side right"><div class="tlabel">${esc(p.sideB.color)}</div>${(p.sideB.players || []).map(x => `<div class="pname">${esc(x.name)}</div>`).join('')}</div>
      </div>`;
  return `<div class="paircard" ${highlight ? 'style="border:2px solid var(--gold)"' : ''}>
    <div class="phead"><span>${esc(p.teeTime || 'TBD')}</span><span>${esc(p.courseLabel || '')}</span></div>
    ${inner}</div>`;
}

/* ============================== ADMIN ============================== */

async function renderAdmin() {
  const el = $('#tab-content');
  if (state.me.role !== 'admin') {
    el.innerHTML = `
      <div class="card"><h2>Admin Login</h2>
        <div class="sub">Tournament directors only.</div>
        <label class="f">Username</label><input id="ad-u" autocomplete="username">
        <label class="f">Password</label><input id="ad-p" type="password" autocomplete="current-password">
        <div class="err hidden" id="ad-e"></div>
        <button class="btn primary block" id="ad-go">Log In</button>
      </div>`;
    $('#ad-go').onclick = async () => {
      try {
        await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: $('#ad-u').value.trim(), password: $('#ad-p').value }) });
        state.me = await api('/api/me');
        showMain(); switchTab('admin');
      } catch (e) { const x = $('#ad-e'); x.textContent = e.message; x.classList.remove('hidden'); }
    };
    return;
  }
  const a = state.admin;
  const tabs = [['players', 'Players'], ['teams', 'Teams'], ['courses', 'Courses'], ['matches', 'Matches'], ['prizes', 'Prizes'], ['export', 'Score Export'], ['setup', 'Setup']];
  el.innerHTML = `
    <div class="admin-nav">${tabs.map(([k, l]) => `<button class="admintab ${a.section === k ? 'active' : ''}" data-s="${k}">${l}</button>`).join('')}</div>
    <div id="admin-body"><div class="card center tiny">Loading…</div></div>`;
  $$('#tab-content .admintab').forEach(b => b.onclick = () => { state.admin.section = b.dataset.s; renderAdmin(); });
  ({ players: adminPlayers, teams: adminTeams, courses: adminCourses, matches: adminMatches, prizes: adminPrizes, export: adminExport, setup: adminSetup })[a.section]();
}

async function adminPlayers() {
  const el = $('#admin-body');
  let players;
  try { players = await api('/api/admin/players'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  el.innerHTML = `<div class="card"><h2>Players & Claim PINs</h2>
    <div class="sub">Text each player their PIN. Tap regenerate to issue a new one.</div>
    ${players.map(p => `
      <details class="adminrow"><summary><span class="swatch" style="background:${teamHex(p.team_color)}"></span> ${esc(p.name)} <span class="tiny">· ${esc(p.team_color || '')} · Tier ${esc(p.tier || '–')} · idx ${p.ghin_index}</span></summary>
      <div class="body">
        <div class="kv"><span>Claim PIN</span><span class="pin">${esc(p.claim_pin || '—')}</span></div>
        <div class="rowflex mt">
          <button class="btn secondary" data-regen="${p.id}">Regenerate PIN</button>
        </div>
        <div class="okmsg hidden" data-ok="${p.id}"></div>
      </div></details>`).join('')}</div>`;
  $$('#admin-body [data-regen]').forEach(b => b.onclick = async () => {
    const id = b.dataset.regen;
    try {
      const r = await api(`/api/admin/players/${id}/regenerate-pin`, { method: 'POST' });
      const ok = $(`[data-ok="${id}"]`);
      ok.textContent = `New PIN: ${r.pin}`; ok.classList.remove('hidden');
      setTimeout(adminPlayers, 1500);
    } catch (e) { alert(e.message); }
  });
}

async function adminTeams() {
  const el = $('#admin-body');
  let teams;
  try { teams = await api('/api/admin/teams'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  el.innerHTML = `<div class="card"><h2>Teams</h2>
    ${teams.map(t => `<div class="kv"><span><span class="swatch" style="background:${teamHex(t.color)}"></span> ${esc(t.color)}</span><span class="tiny">${t.player_count || ''} players</span></div>`).join('')}
  </div>`;
}

async function adminCourses() {
  const el = $('#admin-body');
  let courses;
  try { courses = await api('/api/admin/courses'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  el.innerHTML = `<div class="card"><h2>Courses</h2><div class="sub">Ratings, slopes, and pars are editable placeholders — verify against real scorecards.</div>
    ${courses.map(c => `
      <details class="adminrow"><summary>${esc(c.name)} <span class="tiny">· Black ${c.black_rating}/${c.black_slope}/par ${c.black_par}</span></summary>
      <div class="body">
        <div class="rowflex">
          <div><label class="f">Rating</label><input data-c="${c.id}" data-f="black_rating" type="number" step="0.1" value="${c.black_rating}"></div>
          <div><label class="f">Slope</label><input data-c="${c.id}" data-f="black_slope" type="number" value="${c.black_slope}"></div>
          <div><label class="f">Par</label><input data-c="${c.id}" data-f="black_par" type="number" value="${c.black_par}"></div>
        </div>
        <button class="btn secondary mt" data-save="${c.id}">Save</button>
      </div></details>`).join('')}</div>`;
  $$('#admin-body [data-save]').forEach(b => b.onclick = async () => {
    const id = b.dataset.save;
    const body = {};
    $$(`#admin-body [data-c="${id}"]`).forEach(i => body[i.dataset.f] = Number(i.value));
    try { await api(`/api/admin/courses/${id}`, { method: 'PUT', body: JSON.stringify(body) }); b.textContent = 'Saved ✓'; setTimeout(() => b.textContent = 'Save', 1200); }
    catch (e) { alert(e.message); }
  });
}

async function adminMatches() {
  const el = $('#admin-body');
  let matches;
  try { matches = await api('/api/admin/matches'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  el.innerHTML = `<div class="card"><h2>Matches</h2>
    ${matches.map(m => `
      <details class="adminrow"><summary>Match ${m.match_no} · ${esc(m.label)} ${m.locked ? '<span class="lockedtag">· locked</span>' : ''}</summary>
      <div class="body">
        <div class="tiny">Format: ${esc(m.format)} · Segment: ${esc(m.segment)} · Day: ${esc(m.day)}</div>
        <div class="rowflex mt">
          ${(m.match_no === 6 || m.match_no === 7) && !m.locked ? `<button class="btn secondary" data-gen="${m.match_no}">Generate Singles</button>` : ''}
          <button class="btn secondary" data-lock="${m.match_no}">${m.locked ? 'Unlock' : 'Lock'}</button>
        </div>
      </div></details>`).join('')}</div>`;
  $$('#admin-body [data-gen]').forEach(b => b.onclick = async () => {
    try { const r = await api(`/api/admin/matches/${b.dataset.gen}/generate-singles`, { method: 'POST' }); alert(r.message || 'Singles generated'); adminMatches(); }
    catch (e) { alert(e.message); }
  });
  $$('#admin-body [data-lock]').forEach(b => b.onclick = async () => {
    try { await api(`/api/admin/matches/${b.dataset.lock}/lock`, { method: 'POST', body: JSON.stringify({}) }); adminMatches(); }
    catch (e) { alert(e.message); }
  });
}

async function adminPrizes() {
  const el = $('#admin-body');
  let t;
  try { t = await api('/api/tournament'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  const p = t.prizes || {};
  const fields = [['first', '1st Place'], ['second', '2nd Place'], ['weekendLowNet', 'Weekend Low Net'], ['matchLowNet', 'Match Low Net (each)'], ['scrambleLowNet', 'Scramble Low Net'], ['singlesLowNet', 'Singles Low Net (each)'], ['tierLowNet', 'Tier Low Net (each)']];
  el.innerHTML = `<div class="card"><h2>Prize Settings</h2><div class="sub">Updates the scoreboard legend and boards immediately.</div>
    ${fields.map(([k, l]) => `<label class="f">${l} ($)</label><input data-pk="${k}" type="number" value="${p[k] == null ? '' : p[k]}">`).join('')}
    <label class="f">MVP Award</label><input data-pk="mvpPutter" value="${esc(p.mvpPutter || '')}">
    <button class="btn primary block" id="psave">Save Prizes</button>
    <div class="okmsg hidden" id="pok"></div></div>`;
  $('#psave').onclick = async () => {
    const body = {};
    $$('#admin-body [data-pk]').forEach(i => body[i.dataset.pk] = i.value === '' ? null : (isNaN(Number(i.value)) ? i.value : Number(i.value)));
    try {
      await api(`/api/admin/tournaments/${t.id}/prizes`, { method: 'PUT', body: JSON.stringify(body) });
      state.tournament = await api('/api/tournament');
      const ok = $('#pok'); ok.textContent = 'Saved ✓'; ok.classList.remove('hidden');
    } catch (e) { alert(e.message); }
  };
}

async function adminExport() {
  const el = $('#admin-body');
  el.innerHTML = `<div class="card"><h2>Score Export</h2>
    <div class="sub">Every player's individual gross and net scores, broken down by course.</div>
    <div class="rowflex">
      <button class="btn secondary" id="copyall">Copy All</button>
      <a class="btn primary" href="/api/admin/scores/export.csv" style="text-align:center;text-decoration:none">Download CSV</a>
    </div>
    <div class="okmsg hidden" id="xok"></div>
    <div id="xdata" class="mt"><div class="tiny center">Loading…</div></div></div>`;
  $('#copyall').onclick = async () => {
    try {
      const data = await api('/api/admin/scores/export');
      const txt = JSON.stringify(data, null, 1);
      await navigator.clipboard.writeText(txt);
      const ok = $('#xok'); ok.textContent = 'All course scores copied ✓'; ok.classList.remove('hidden');
    } catch (e) { alert(e.message); }
  };
  try {
    const data = await api('/api/admin/scores/export');
    $('#xdata').innerHTML = data.players.map(p => `
      <details class="adminrow"><summary>${esc(p.name)} <span class="tiny">· ${esc(p.team || '')}</span></summary>
      <div class="body">${Object.entries(p.courses).map(([cn, c]) => `
        <div class="kv"><span>${esc(cn)} <span class="tiny">· thru ${c.thru}</span></span>
        <span>Gross ${c.grossTotal} · Net ${c.netTotal}</span></div>`).join('') || '<div class="tiny">No scores yet.</div>'}</div>
      </details>`).join('');
  } catch (e) { $('#xdata').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

async function adminSetup() {
  const el = $('#admin-body');
  let t;
  try { t = await api('/api/tournament'); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  el.innerHTML = `<div class="card"><h2>Tournament Setup</h2>
    <div class="kv"><span>Name</span><b>${esc(t.name)} ${t.year}</b></div>
    <div class="kv"><span>Status</span><b>${esc(t.status)}</b></div>
    <label class="f mt">Spectator Code</label>
    <div class="rowflex"><input id="scode" value="${esc(t.spectator_code || '')}"><button class="btn secondary" id="scodesave" style="flex:0 0 auto">Save</button></div>
    <div class="section-title">Change Admin Password</div>
    <label class="f">Current</label><input id="cpw0" type="password">
    <label class="f">New</label><input id="cpw1" type="password">
    <button class="btn secondary block" id="cpwgo">Change Password</button>
    <div class="okmsg hidden" id="sok"></div></div>`;
  $('#scodesave').onclick = async () => {
    try {
      await api(`/api/admin/tournaments/${t.id}`, { method: 'PUT', body: JSON.stringify({ spectator_code: $('#scode').value.trim() }) });
      const ok = $('#sok'); ok.textContent = 'Spectator code saved ✓'; ok.classList.remove('hidden');
    } catch (e) { alert(e.message); }
  };
  $('#cpwgo').onclick = async () => {
    try {
      await api('/api/admin/change-password', { method: 'POST', body: JSON.stringify({ current: $('#cpw0').value, next: $('#cpw1').value }) });
      const ok = $('#sok'); ok.textContent = 'Password changed ✓'; ok.classList.remove('hidden');
    } catch (e) { alert(e.message); }
  };
}

// Start the app
boot();
