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

const TAB_TITLES = { leaderboard: 'Leaderboard', scoring: 'Scoring', boards: 'Boards', calcutta: 'Calcutta', schedule: 'Schedule', admin: 'Admin' };

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
  ({ leaderboard: renderLeaderboard, scoring: renderScoring, boards: renderBoards, calcutta: renderCalcutta, schedule: renderSchedule, admin: renderAdmin })[state.tab]();
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
    // For M6/M7: show placeholders until pairings are generated (via Admin Generate button)
    if ((n === 6 || n === 7) && (!m || !m.rows || m.rows.length === 0)) {
      host.innerHTML = matchPlaceholderCard(n);
      return;
    }
    host.innerHTML = m ? matchPairCard(m) : `<div class="card center tiny">No pairings yet.</div>`;
  } catch { host.innerHTML = `<div class="card center tiny">Couldn't load pairings.</div>`; }
}

/* Placeholder cards for M6/M7 Match Center until M5 is final.
   Uses exact tee times and seeding matchups from Trice's spreadsheet. */
function matchPlaceholderCard(n) {
  const isM6 = n === 6;
  const label = isM6 ? 'MATCH 6 · SATURDAY PM SINGLES' : 'MATCH 7 · SATURDAY PM SINGLES';
  const course = isM6 ? 'Dye Front' : 'Dye Back';
  // [time, [playerA1, playerB1], [playerA2, playerB2]] — two singles matches per tee time
  const m6Slots = [
    ['1:53 PM', ['9th Place A', '10th Place A'], ['9th Place D', '10th Place D']],
    ['2:02 PM', ['7th Place A', '8th Place A'], ['7th Place D', '8th Place D']],
    ['2:11 PM', ['5th Place A', '6th Place A'], ['5th Place D', '6th Place D']],
    ['2:20 PM', ['9th Place B', '10th Place B'], ['9th Place C', '10th Place C']],
    ['2:29 PM', ['7th Place B', '8th Place B'], ['7th Place C', '8th Place C']],
    ['2:38 PM', ['5th Place B', '6th Place B'], ['5th Place C', '6th Place C']],
    ['2:47 PM', ['2nd Place A', '3rd Place A'], ['2nd Place D', '3rd Place D']],
    ['2:56 PM', ['1st Place A', '4th Place A'], ['1st Place D', '4th Place D']],
    ['3:05 PM', ['2nd Place B', '3rd Place B'], ['2nd Place C', '3rd Place C']],
    ['3:14 PM', ['1st Place B', '4th Place B'], ['1st Place C', '4th Place C']],
  ];
  const m7Slots = [
    ['1:53 PM', ['9th Place A', '8th Place A'], ['9th Place D', '8th Place D']],
    ['2:02 PM', ['5th Place A', '10th Place A'], ['5th Place D', '10th Place D']],
    ['2:11 PM', ['6th Place A', '7th Place A'], ['6th Place D', '7th Place D']],
    ['2:20 PM', ['9th Place B', '8th Place B'], ['9th Place C', '8th Place C']],
    ['2:29 PM', ['5th Place B', '10th Place B'], ['5th Place C', '10th Place C']],
    ['2:38 PM', ['6th Place B', '7th Place B'], ['6th Place C', '7th Place C']],
    ['2:47 PM', ['4th Place A', '3rd Place A'], ['4th Place D', '3rd Place D']],
    ['2:56 PM', ['1st Place A', '2nd Place A'], ['1st Place D', '2nd Place D']],
    ['3:05 PM', ['4th Place B', '3rd Place B'], ['4th Place C', '3rd Place C']],
    ['3:14 PM', ['1st Place B', '2nd Place B'], ['1st Place C', '2nd Place C']],
  ];
  const slots = isM6 ? m6Slots : m7Slots;
  // Each singles match gets its own card (two cards per tee time)
  const cards = [];
  slots.forEach(([time, [a1, b1], [a2, b2]]) => {
    cards.push({ time, a: a1, b: b1 });
    cards.push({ time, a: a2, b: b2 });
  });
  return `
    <div class="section-title">${label}</div>
    <div class="sub" style="margin-bottom:12px">Pairings set after Match 5 · Seeded by standings</div>
    ${cards.map(({ time, a, b }) => `
      <div class="paircard">
        <div class="phead"><span>${time}</span><span>${course}</span></div>
        <div class="matchstatus"><div style="color:#8895a2;font-weight:800;font-size:1.1em">TBD</div></div>
        <div class="vs">
          <div class="side"><div class="tlabel" style="font-size:0.95em">${esc(a)}</div></div>
          <div class="vsbadge">VS</div>
          <div class="side right"><div class="tlabel" style="font-size:0.95em">${esc(b)}</div></div>
        </div>
      </div>`).join('')}
  `;
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
    // Place is PER COURSE: 1st-6th on Norman, 1st-4th on Fazio (sorted by relPar)
    const courseOrder = Object.keys(byCourse).sort();
    return `
    <div class="section-title" style="margin-top:14px">${esc(m.label)}</div>
    ${courseOrder.map(course => {
      // Sort this course group by relPar ascending (nulls last), assign 1st, 2nd, etc.
      const sorted = [...byCourse[course]].sort((a, b) => {
        const ap = a.relPar == null ? 999 : a.relPar;
        const bp = b.relPar == null ? 999 : b.relPar;
        return ap - bp;
      });
      const placeByKey = new Map();
      sorted.forEach((row, i) => {
        const key = row.pairingId || row.color + row.teeTime;
        placeByKey.set(key, i + 1);
      });
      return `
      <div class="section-title" style="margin-top:10px;font-size:0.9em;color:var(--muted)">${esc(course)}</div>
      ${sorted.map(row => {
        if (row.noCourse) return `<div class="paircard"><div class="phead"><span>${esc(row.teeTime || '')}</span><span>Course TBD</span></div></div>`;
        const key = row.pairingId || row.color + row.teeTime;
        return scrambleRowCard(row, placeByKey.get(key));
      }).join('')}
    `;}).join('')}`;
  }
  return `
    <div class="section-title" style="margin-top:14px">${esc(m.label)}</div>
    ${m.rows.map(row => {
      if (row.noCourse) return `<div class="paircard"><div class="phead"><span>${esc(row.teeTime || '')}</span><span>Course TBD</span></div></div>`;
      return pairVsCard(row, m);
    }).join('')}`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function scrambleRowCard(ev, place) {
  const score = ev.relPar == null ? '–' : fmtToPar(ev.relPar);
  const scoreColor = ev.relPar == null ? '#8895a2' : ev.relPar < 0 ? '#16a34a' : ev.relPar > 0 ? '#dc2626' : '#666';
  const placeBadge = place ? `<span style="font-size:1.3em;font-weight:800;color:#1a2332;margin-right:8px">${ordinal(place)}</span>` : '';
  return `
    <div class="paircard">
      <div class="phead"><span>${esc(ev.teeTime || '')}</span><span>${esc(ev.courseName || '')}</span></div>
      <div class="vs"><div class="side">
        <div class="tlabel" style="color:${teamHex(ev.color)}">${placeBadge}${esc(ev.color)}</div>
        <div class="matchstatus" style="margin:2px 0">${ev.complete ? 'Final' : 'Thru ' + ev.thru}</div>
        <div style="font-size:2em;font-weight:800;color:${scoreColor};line-height:1">${score}</div>
      </div></div>
    </div>`;
}

function pairVsCard(ev, m) {
  // Status: "{Team} {Margin}" in team color on line 1, "Final"/"Thru X" on line 2
  // If lead > holes remaining, show "Team X&Y" (e.g., "Maroon 3&2")
  const leadName = ev.leader === 'A' ? ev.colorA : ev.leader === 'B' ? ev.colorB : null;
  const leadColor = leadName ? teamHex(leadName) : '#8895a2';
  const fmtMargin = (status) => {
    if (!leadName || !status || status === 'A/S') return leadName || 'Tied';
    const upMatch = status.match(/(\d+)\s*Up/i);
    if (upMatch) {
      const lead = parseInt(upMatch[1], 10);
      if (ev.closedOut != null && ev.closedOut > 0) return `${leadName} ${lead}&${ev.closedOut}`;
    }
    return `${leadName} ${status}`;
  };
  let topLine, botLine;
  if (ev.final) {
    const margin = ev.status && ev.status !== 'A/S' ? ev.status : (ev.winner && ev.winner !== 'T' ? '1 Up' : '');
    topLine = leadName && margin ? fmtMargin(margin) : (leadName ? `${leadName} wins` : 'Tied');
    // If it was a closed-out win, fmtMargin already handles the & format
    if (leadName && margin && !topLine.includes('&')) topLine = fmtMargin(margin);
    botLine = 'Final';
  } else if (leadName && ev.status && ev.status !== 'A/S') {
    topLine = fmtMargin(ev.status);
    botLine = ev.through != null ? `Thru ${ev.through}` : '';
  } else {
    topLine = 'Tied';
    botLine = ev.through != null ? `Thru ${ev.through}` : '';
  }
  const statusHtml = `<div class="matchstatus"><div style="color:${leadColor};font-weight:800;font-size:1.3em">${esc(topLine)}</div>${botLine ? `<div style="color:#8895a2;font-size:1.1em;font-weight:700">${esc(botLine)}</div>` : ''}</div>`;
  const strip = (ev.holes || []).map(h => {
    let bg = '#eef2f7', color = 'var(--muted)';
    if (h.winner === 'A' && ev.colorA) { bg = teamHex(ev.colorA); color = '#fff'; }
    else if (h.winner === 'B' && ev.colorB) { bg = teamHex(ev.colorB); color = '#fff'; }
    else if (h.winner === 'H') { bg = '#cbd5e1'; color = '#475569'; }
    return `<div class="holepip" style="background:${bg};color:${color}">${h.hole}</div>`;
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
    // Middle: "Yellow 1 Up", "Yellow 3&2", or "Tied"
    // Backend locks the result when lead > remaining: ev.closedOut = holes remaining at lock.
    // If closedOut > 0, show "Team X&Y". If 0 or null (won on last hole), show "Team X Up".
    let marginText = 'Tied';
    if (leadName) {
      const status = ev.status && ev.status !== 'A/S' ? ev.status : '';
      const upMatch = status.match(/(\d+)\s*Up/i);
      if (upMatch) {
        const lead = parseInt(upMatch[1], 10);
        if (ev.closedOut != null && ev.closedOut > 0) {
          marginText = `${leadName} ${lead}&${ev.closedOut}`;
        } else {
          marginText = `${leadName} ${status}`;
        }
      } else if (status) {
        marginText = `${leadName} ${status}`;
      } else {
        marginText = leadName;
      }
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
  // Color each hole by the winning team's color.
  const holeBtns = holes.map((h, i) => {
    const scored = scoringPlayers().some(p => ((s.detail.scores || {})[p.id] || {})[h.hole] != null);
    const isActive = i === s.holeIdx;
    let style = '';
    if (!isScr) {
      const hr = (ev.holes || []).find(x => x.hole === h.hole);
      if (hr) {
        if (hr.winner === 'A' && ev.colorA) style = `background:${teamHex(ev.colorA)};color:#fff;border-color:${teamHex(ev.colorA)};`;
        else if (hr.winner === 'B' && ev.colorB) style = `background:${teamHex(ev.colorB)};color:#fff;border-color:${teamHex(ev.colorB)};`;
        else if (hr.winner === 'H') style = `background:#cbd5e1;color:#475569;border-color:#cbd5e1;`;
      }
    }
    // Active hole gets a ring to stand out, even with winner color
    if (isActive) style += 'box-shadow:0 0 0 2px #fff,0 0 0 4px var(--navy-800);';
    return `<button class="hbtn ${isActive ? 'active' : ''} ${scored ? 'scored' : ''}" data-i="${i}" style="${style}">${h.hole}</button>`;
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
  const who = data.format === 'scramble' ? 'Team' : data.format === 'singles' ? 'Player' : 'Pair';
  let html = `<div class="card"><h2>${label}</h2><div class="sub">Live · tap a row for hole-by-hole</div></div>`;
  html += `<div class="boardhead"><span></span><span>${who}</span><span class="num">Thru</span><span class="num">To Par</span></div>`;
  data.rows.forEach((r, i) => {
    const name = data.format === 'scramble' ? r.color
      : data.format === 'singles' ? r.name
      : r.players.map(p => p.name).join(' & ');
    const color = r.color;
    html += `<details class="boardrow"><summary><span class="rank">${i + 1}</span>`
      + `<span class="bname"><span class="swatch" style="background:${teamHex(color)}"></span><span class="t">${esc(name)}</span></span>`
      + `<span class="num">${r.thru || '–'}</span>`
      + `<span class="num ${toParClass(r.toPar)}">${fmtToPar(r.toPar)}</span></summary>`
      + `<div class="body">${matchDetailHtml(data.format, r)}</div></details>`;
  });
  el.innerHTML = html;
}

/* Hole chips for the expandable board rows: gross big, net small (net omitted for scramble).
   `taken` (optional): parallel bool array — highlighted nets counted for best ball. */
function holeChips(holes, showNet, taken) {
  return `<div class="dchips">${holes.map((h, i) => {
    const g = h.gross == null ? '–' : h.gross;
    const isTaken = taken && taken[i];
    const n = showNet ? `<span class="${isTaken ? 'taken' : ''}">${h.net == null ? '–' : h.net}</span>` : '';
    return `<div class="dchip"><em>${h.hole}</em><b>${g}</b>${n}</div>`;
  }).join('')}</div>`;
}

function matchDetailHtml(format, r) {
  if (format === 'scramble') {
    const holes = (r.holes || []).map((g, i) => ({ hole: i + 1, gross: g }));
    return `<div class="dsub">${esc(r.course || '')}${r.teeTime ? ' · ' + esc(r.teeTime) : ''}</div>`
      + holeChips(holes, false)
      + `<div class="dtotal">Total ${r.total == null ? '–' : r.total} · ${fmtToPar(r.toPar)} · thru ${r.thru || 0}</div>`;
  }
  if (format === 'singles') {
    const holes = r.detail || [];
    let g = 0, nt = 0;
    holes.forEach(h => { if (h.gross != null) g += h.gross; if (h.net != null) nt += h.net; });
    return (r.strokes != null ? `<div class="dsub">${r.strokes} strokes</div>` : '')
      + holeChips(holes, true)
      + `<div class="dtotal">Total ${g} gross · ${nt} net</div>`;
  }
  // best-ball pairs: one block per player; highlight each hole's taken net
  const bplayers = r.detail || [];
  const bnh = Math.max(0, ...bplayers.map(p => (p.holes || []).length));
  const takenBy = [];
  for (let i = 0; i < bnh; i++) {
    let bi = -1, bn = null;
    bplayers.forEach((pl, pi) => {
      const n = (pl.holes[i] || {}).net;
      if (n != null && (bn == null || n < bn)) { bn = n; bi = pi; }
    });
    takenBy.push(bi);
  }
  let bout = bplayers.map((pl, pi) => {
    let g = 0, nt = 0;
    (pl.holes || []).forEach(h => { if (h.gross != null) g += h.gross; if (h.net != null) nt += h.net; });
    const flags = (pl.holes || []).map((_, i) => takenBy[i] === pi);
    return `<div class="dplayer">${esc(pl.name)}${pl.strokes != null ? ` <span class="tiny">· ${pl.strokes} STR</span>` : ''}</div>`
      + holeChips(pl.holes || [], true, flags)
      + `<div class="dtotal">Total ${g} gross · ${nt} net</div>`;
  }).join('');
  bout += `<div class="dsub">Highlighted nets are the ones counted — they add up to the pair's ${r.net}.</div>`;
  return bout;
}

async function renderWeekendBoard() {
  const el = $('#board-body');
  const tier = state.boards.tier === 'ALL' ? '' : `?tier=${state.boards.tier}`;
  let data;
  try { data = await api(`/api/boards/weekend${tier}`); }
  catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }
  let html = `<div class="card"><h2>Weekend Low Net ${state.boards.tier === 'ALL' ? '' : '· Tier ' + esc(state.boards.tier)}</h2><div class="sub">Thru is holes completed of 54 · tap a player for per-course scoring</div></div>`;
  html += `<div class="boardhead"><span></span><span>Player</span><span class="num">Thru</span><span class="num">Net</span><span class="num">To Par</span></div>`;
  data.rows.forEach((r, i) => {
    html += `<details class="boardrow"><summary><span class="rank">${i + 1}</span>`
      + `<span class="bname"><span class="swatch" style="background:${teamHex(r.color)}"></span><span class="t">${esc(r.name)} <span class="pill">${esc(r.tier || '')}</span></span></span>`
      + `<span class="num">${r.thru || '–'}</span>`
      + `<span class="num">${r.netTotal == null ? '–' : r.netTotal}</span>`
      + `<span class="num ${toParClass(r.toPar)}">${fmtToPar(r.toPar)}</span></summary>`
      + `<div class="body">${weekendDetailHtml(r)}</div></details>`;
  });
  el.innerHTML = html;
}

function weekendDetailHtml(r) {
  const courses = r.courses || [];
  if (!courses.length) return `<div class="dsub">No scores yet</div>`;
  return `<table class="rows mini"><thead><tr><th>Course</th><th class="num">Gross</th><th class="num">Net</th><th class="num">To Par</th></tr></thead><tbody>`
    + courses.map(c => `<tr><td>${esc(c.course)}</td><td class="num">${c.gross}</td><td class="num">${c.net}</td><td class="num ${toParClass(c.toPar)}">${fmtToPar(c.toPar)}</td></tr>`).join('')
    + `</tbody></table>`;
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
    // M2/M5/M7: show "Following front 9" instead of TBD time.
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
  // Personalized header: "Trice's Tee Times" for players, "Tee Times" for others
  const playerName = state.me && state.me.player ? state.me.player.name : null;
  const firstName = playerName ? playerName.split(' ')[0] : null;
  const headerTitle = firstName ? `${firstName}'s Tee Times` : 'Tee Times';
  html += `<div style="font-size:1.5em;font-weight:800;margin-bottom:8px">${esc(headerTitle)}</div>`;
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
      <details class="adminrow"><summary>Match ${m.match_no} · ${esc(m.label)}</summary>
      <div class="body">
        <div class="tiny">Format: ${esc(m.format)} · Segment: ${esc(m.segment)} · Day: ${esc(m.day)}</div>
        <div class="rowflex mt">
          ${m.match_no === 6 ? `<button class="btn secondary" data-gen-both="1">Generate Singles (M6 & M7)</button>` : ''}
        </div>
      </div></details>`).join('')}</div>`;
  $$('#admin-body [data-gen-both]').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/admin/matches/6/generate-singles`, { method: 'POST' });
      await api(`/api/admin/matches/7/generate-singles`, { method: 'POST' });
      alert('Singles generated for M6 & M7'); adminMatches();
    } catch (e) { alert(e.message); }
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
  // Danger Zone: Clear all scores (double confirmation required)
  const dz = document.createElement('div');
  dz.className = 'card';
  dz.style.marginTop = '16px';
  dz.style.borderColor = '#ca4747';
  dz.innerHTML = `
    <h2 style="color:#ca4747">Danger Zone</h2>
    <div class="sub">Wipe all entered scores and reset the tournament to a pre-start state. This cannot be undone.</div>
    <button class="btn block" id="clearscores" style="background:#ca4747;color:#fff">Clear All Scores</button>
    <div class="okmsg hidden" id="clearmsg"></div>`;
  el.appendChild(dz);
  let armed = false;
  $('#clearscores').onclick = async () => {
    const btn = $('#clearscores');
    const msg = $('#clearmsg');
    if (!armed) {
      armed = true;
      btn.textContent = 'Are you sure? Tap again to wipe all scores';
      btn.style.background = '#863c4b';
      setTimeout(() => { armed = false; btn.textContent = 'Clear All Scores'; btn.style.background = '#ca4747'; }, 10000);
      return;
    }
    armed = false;
    btn.textContent = 'Clearing…';
    btn.disabled = true;
    try {
      const r = await api('/api/admin/clear-all-scores', { method: 'POST' });
      msg.textContent = `All scores cleared ✓ (${r.hole_scores + r.scramble_scores} entries removed)`;
      msg.classList.remove('hidden');
      btn.textContent = 'Clear All Scores';
      btn.style.background = '#ca4747';
      btn.disabled = false;
    } catch (e) {
      msg.textContent = 'Error: ' + e.message;
      msg.classList.remove('hidden');
      btn.textContent = 'Clear All Scores';
      btn.style.background = '#ca4747';
      btn.disabled = false;
    }
  };
}

/* ============================== CALCUTTA ============================== */
/* Thursday-night auction: bidders buy a % of each team. Admin verifies
   Venmo before entering a bid (paid flag); share of team = bid / team total. */

let calcuttaTeamId = null;
let calcuttaLastBet = null; // {amount_cents, color} — shown with the Venmo prompt after betting
const cMoney = c => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: (c % 100) ? 2 : 0 });

async function renderCalcutta() {
  const el = $('#tab-content');
  el.innerHTML = `<div class="card center tiny">Loading Calcutta…</div>`;
  const isAdmin = state.me.role === 'admin';
  const isPlayer = state.me.role === 'player';
  let board, payoutData, players = [], mine = [];
  try {
    const reqs = [api('/api/calcutta'), api('/api/calcutta/payouts')];
    if (isAdmin) reqs.push(api('/api/admin/players'));
    if (isPlayer) reqs.push(api('/api/calcutta/mine'));
    const out = await Promise.all(reqs);
    board = out[0]; payoutData = out[1];
    let i = 2;
    if (isAdmin) players = out[i++];
    if (isPlayer) mine = out[i++].bets;
  } catch (e) { el.innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`; return; }

  if (!board.teams.some(t => t.id === calcuttaTeamId)) {
    calcuttaTeamId = (board.teams.slice().sort((a, b) => b.total_cents - a.total_cents)[0] || {}).id ?? null;
  }
  const team = board.teams.find(t => t.id === calcuttaTeamId);

  let html = `
    <div class="card cpool">
      <div class="sub">Calcutta Pool</div>
      <div class="cpool-total">${cMoney(board.pool_cents)}</div>
      <div class="tiny">${board.bid_count} bid${board.bid_count === 1 ? '' : 's'} · Paid ${cMoney(board.paid_cents)}${board.pending_cents > 0 ? ` · <span class="cpending">Pending ${cMoney(board.pending_cents)}</span>` : ''}</div>
    </div>`;

  if (calcuttaLastBet) {
    const lb = calcuttaLastBet;
    const vuser = board.venmo_username;
    html += `
    <div class="card cconfirm">
      <h2>Bet placed ✓</h2>
      <div class="sub">${cMoney(lb.amount_cents)} on <b>${esc(lb.color)}</b>.</div>
      ${lb.unpaid_cents > 0 ? `
        <div class="cpool-total" style="font-size:26px;margin-top:6px">${cMoney(lb.unpaid_cents)}</div>
        <div class="sub">Total to send on Venmo</div>
        ${vuser
          ? `<a class="btn primary block cvenmo" href="https://venmo.com/u/${encodeURIComponent(vuser)}" target="_blank" rel="noopener">Pay ${cMoney(lb.unpaid_cents)} to @${esc(vuser)} on Venmo</a>
             <div class="tiny" style="margin-top:6px">Put “Fellas Calcutta” in the Venmo note.</div>`
          : `<div class="sub">Send ${cMoney(lb.unpaid_cents)} to Trice on Venmo with the note “Fellas Calcutta”.</div>`}
      ` : `<div class="sub">You're all paid up ✓</div>`}
    </div>`;
    calcuttaLastBet = null;
  }

  if (isPlayer) {
    const myTotal = mine.reduce((s, b) => s + b.amount_cents, 0);
    html += `
    <div class="card">
      <h2>Your bets <span class="tiny">· ${cMoney(myTotal)} total</span></h2>
      ${mine.length === 0 ? `<div class="sub">No bets yet — pick a team below.</div>` : mine.map(b => `
        <div class="cbid">
          <div class="cbid-main"><b><span class="cdot" style="background:${teamHex(b.color)}"></span>${esc(b.color)}</b><span class="tiny">${b.pct}% of team</span></div>
          <div class="cbid-amt">${cMoney(b.amount_cents)} ${b.paid ? '<span class="cpaidmark">✓ paid</span>' : '<span class="cpending">pending</span>'}</div>
        </div>`).join('')}
    </div>`;
    if (board.open) {
      html += `
    <div class="card">
      <h2>Place a bet</h2>
      <div class="sub">Own a piece of a team — your % of the team wins 100% of the pool if they win it all. You'll pay on Venmo right after.</div>
      <div class="cform crow">
        <label>Team<select id="cbet-team">${board.teams.map(t => `<option value="${t.id}">${esc(t.color)} — ${cMoney(t.total_cents)} in</option>`).join('')}</select></label>
        <label>Amount $<input id="cbet-amount" type="number" min="1" step="1" placeholder="100"></label>
      </div>
      <div class="tiny" id="cbet-preview" style="margin:2px 0 6px"></div>
      <button class="btn gold block" id="cbet-go">Bet &amp; pay on Venmo</button>
      <div class="err hidden" id="cbet-err"></div>
    </div>`;
    } else {
      html += `<div class="card"><div class="sub">Betting is closed for this Calcutta.</div></div>`;
    }
  }

  html += `
    <div class="mpill-row" style="margin:12px 0">
      ${board.teams.map(t => `<button class="mpill${t.id === calcuttaTeamId ? ' active' : ''}" data-ct="${t.id}"><span class="cdot" style="background:${teamHex(t.color)}"></span>${esc(t.color)} <b>${cMoney(t.total_cents)}</b></button>`).join('')}
    </div>`;

  if (team) {
    html += `
    <div class="card">
      <h2><span class="cdot" style="background:${teamHex(team.color)}"></span> ${esc(team.color)} <span class="tiny">· ${cMoney(team.total_cents)} total</span></h2>
      ${team.bids.length === 0 ? `<div class="sub">No bids yet.</div>` : team.bids.map(b => `
        <div class="cbid">
          <div class="cbid-main">
            <b>${esc(b.name)}</b>
            <span class="tiny">${b.pct}% of team</span>
          </div>
          ${isAdmin
            ? `<input class="camt" type="number" min="1" step="1" value="${b.amount_cents / 100}" data-bid="${b.id}" aria-label="Bid amount">
               <button class="cpaid${b.paid ? ' on' : ''}" data-bid="${b.id}" title="Toggle paid">${b.paid ? '✓' : '⏳'}</button>
               <button class="cdel" data-bid="${b.id}" title="Delete bid">✕</button>`
            : `<div class="cbid-amt">${cMoney(b.amount_cents)} ${b.paid ? '<span class="cpaidmark">✓</span>' : '<span class="cpending">pending</span>'}</div>`}
        </div>`).join('')}
    </div>`;
  }

  html += `
    <details class="card">
      <summary><b>Projected payouts</b> <span class="tiny">· based on live standings</span></summary>
      <div class="sub">Paid pool ${cMoney(board.paid_cents)} split ${payoutData.payouts.map(p => `${ordinal(p.place)} ${p.pct}%`).join(' / ')}.</div>
      ${payoutData.payouts.map(p => `
        <div class="cpay">
          <div class="cpay-head"><span class="cdot" style="background:${teamHex(p.color)}"></span><b>${ordinal(p.place)} · ${esc(p.color)}</b><b>${cMoney(p.prize_cents)}</b></div>
          ${p.cuts.map(c => `<div class="cbid"><div class="cbid-main"><b>${esc(c.name)}</b><span class="tiny">${c.pct}% of team</span></div><div class="cbid-amt">${cMoney(c.cut_cents)}</div></div>`).join('')}
        </div>`).join('')}
    </details>`;

  if (isAdmin) {
    html += `
    <div class="card">
      <h2>Calcutta settings</h2>
      <button class="btn ${board.open ? 'secondary' : 'primary'} block" id="cs-toggle" style="margin-top:0">${board.open ? 'Close betting' : 'Reopen betting'}</button>
      <div class="sub" style="margin-top:10px">Your Venmo username — players get a pay button with it after betting.</div>
      <div class="cform crow" style="align-items:flex-end">
        <label style="flex:1">@<input id="cs-venmo" type="text" placeholder="your-venmo-name" value="${esc(board.venmo_username || '')}" autocapitalize="none"></label>
        <button class="btn secondary" id="cs-save" style="margin:6px 0">Save</button>
      </div>
      <div class="err hidden" id="cs-err"></div>
      <div class="okmsg hidden" id="cs-ok"></div>
    </div>
    <div class="card">
      <h2>Enter a bid</h2>
      <div class="sub">Verify the bidder's Venmo <b>before</b> entering — leave Paid checked once you've confirmed it.</div>
      <div class="cform">
        <label>Bidder<select id="cb-player">${players.map(p => `<option value="${p.id}">${esc(p.name)}${p.team_color ? ` (${esc(p.team_color)})` : ''}</option>`).join('')}</select></label>
        <label>Team<select id="cb-team">${board.teams.map(t => `<option value="${t.id}">${esc(t.color)} — ${cMoney(t.total_cents)} in</option>`).join('')}</select></label>
        <label>Amount $<input id="cb-amount" type="number" min="1" step="1" placeholder="100"></label>
        <label class="ccheck"><input id="cb-paid" type="checkbox" checked> Paid (Venmo verified)</label>
        <button class="btn primary block" id="cb-add">Add bid</button>
        <div class="err hidden" id="cb-err"></div>
      </div>
    </div>
    <div class="card">
      <h2>Payout split</h2>
      <div class="sub">% of the paid pool to the 1st / 2nd / 3rd place teams. Must add up to 100%.</div>
      <div class="crow">
        <label>1st<input id="cp-1" type="number" min="0" max="100" value="${board.payouts[1]}"></label>
        <label>2nd<input id="cp-2" type="number" min="0" max="100" value="${board.payouts[2]}"></label>
        <label>3rd<input id="cp-3" type="number" min="0" max="100" value="${board.payouts[3]}"></label>
      </div>
      <button class="btn secondary block" id="cp-save">Save payout split</button>
      <div class="err hidden" id="cp-err"></div>
      <div class="okmsg hidden" id="cp-ok"></div>
    </div>
    <div class="card" style="border-color:#ca4747">
      <h2 style="color:#ca4747">Danger Zone</h2>
      <div class="sub">Wipe all Calcutta bids and start the auction over. Cannot be undone.</div>
      <button class="btn block" id="cb-clear" style="background:#ca4747;color:#fff">Clear All Bids</button>
    </div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll('[data-ct]').forEach(b => b.onclick = () => { calcuttaTeamId = Number(b.dataset.ct); renderCalcutta(); });

  if (isPlayer && board.open) {
    const updPreview = () => {
      const team = board.teams.find(t => t.id === Number($('#cbet-team').value));
      const amt = Number($('#cbet-amount').value) || 0;
      const prev = $('#cbet-preview');
      if (!prev) return;
      if (team && amt > 0) {
        const pct = amt / (team.total_cents / 100 + amt) * 100;
        prev.textContent = `${cMoney(amt * 100)} would be about ${pct.toFixed(1)}% of ${team.color} (${cMoney(team.total_cents)} in so far)`;
      } else if (team) {
        prev.textContent = `${cMoney(team.total_cents)} bet on ${team.color} so far`;
      } else {
        prev.textContent = '';
      }
    };
    $('#cbet-team').onchange = updPreview;
    $('#cbet-amount').oninput = updPreview;
    updPreview();
    $('#cbet-go').onclick = async () => {
      const err = $('#cbet-err'); err.classList.add('hidden');
      const teamId = Number($('#cbet-team').value);
      const amount = Number($('#cbet-amount').value);
      const team = board.teams.find(t => t.id === teamId);
      try {
        const resp = await api('/api/calcutta/bets', { method: 'POST', body: JSON.stringify({ team_id: teamId, amount }) });
        calcuttaLastBet = { amount_cents: Math.round(amount * 100), color: team ? team.color : '', unpaid_cents: resp.my_unpaid_cents || 0 };
        renderCalcutta();
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    };
  }

  if (isAdmin) {
    $('#cs-toggle').onclick = async () => {
      const err = $('#cs-err'); err.classList.add('hidden');
      try {
        await api('/api/admin/calcutta/settings', { method: 'PUT', body: JSON.stringify({ open: !board.open }) });
        renderCalcutta();
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    };
    $('#cs-save').onclick = async () => {
      const err = $('#cs-err'), ok = $('#cs-ok');
      err.classList.add('hidden'); ok.classList.add('hidden');
      try {
        await api('/api/admin/calcutta/settings', { method: 'PUT', body: JSON.stringify({
          venmo_username: $('#cs-venmo').value,
        }) });
        ok.textContent = 'Venmo username saved ✓'; ok.classList.remove('hidden');
        renderCalcutta();
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    };
    el.querySelectorAll('.camt').forEach(inp => {
      inp.onchange = async () => {
        try {
          await api(`/api/admin/calcutta/bids/${inp.dataset.bid}`, { method: 'PATCH', body: JSON.stringify({ amount: Number(inp.value) }) });
          renderCalcutta();
        } catch (e) { inp.classList.add('cerr'); setTimeout(() => inp.classList.remove('cerr'), 1500); }
      };
    });
    el.querySelectorAll('.cpaid').forEach(btn => {
      btn.onclick = async () => {
        const on = !btn.classList.contains('on');
        await api(`/api/admin/calcutta/bids/${btn.dataset.bid}`, { method: 'PATCH', body: JSON.stringify({ paid: on }) });
        renderCalcutta();
      };
    });
    el.querySelectorAll('.cdel').forEach(btn => {
      btn.onclick = async () => {
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1'; btn.textContent = 'Sure?';
          setTimeout(() => { delete btn.dataset.armed; btn.textContent = '✕'; }, 4000);
          return;
        }
        await api(`/api/admin/calcutta/bids/${btn.dataset.bid}`, { method: 'DELETE' });
        renderCalcutta();
      };
    });
    $('#cb-add').onclick = async () => {
      const err = $('#cb-err'); err.classList.add('hidden');
      try {
        await api('/api/admin/calcutta/bids', { method: 'POST', body: JSON.stringify({
          player_id: Number($('#cb-player').value),
          team_id: Number($('#cb-team').value),
          amount: Number($('#cb-amount').value),
          paid: $('#cb-paid').checked,
        }) });
        calcuttaTeamId = Number($('#cb-team').value);
        renderCalcutta();
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    };
    $('#cp-save').onclick = async () => {
      const err = $('#cp-err'), ok = $('#cp-ok');
      err.classList.add('hidden'); ok.classList.add('hidden');
      try {
        await api('/api/admin/calcutta/payouts', { method: 'PUT', body: JSON.stringify({
          1: Number($('#cp-1').value), 2: Number($('#cp-2').value), 3: Number($('#cp-3').value),
        }) });
        ok.textContent = 'Payout split saved ✓'; ok.classList.remove('hidden');
        renderCalcutta();
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    };
    let armed = false;
    $('#cb-clear').onclick = async () => {
      const btn = $('#cb-clear');
      if (!armed) {
        armed = true;
        btn.textContent = 'Are you sure? Tap again to wipe all bids';
        setTimeout(() => { armed = false; btn.textContent = 'Clear All Bids'; }, 10000);
        return;
      }
      armed = false;
      btn.textContent = 'Clearing…'; btn.disabled = true;
      try { await api('/api/admin/calcutta/bids', { method: 'DELETE' }); renderCalcutta(); }
      catch (e) { btn.textContent = 'Clear All Bids'; btn.disabled = false; }
    };
  }
}

// Start the app
boot();
