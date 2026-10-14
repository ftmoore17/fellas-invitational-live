#!/usr/bin/env node
/**
 * Venmo payment watcher for the Fellas Invitational Calcutta.
 *
 * Venmo has no public API, so this watches Trice's Gmail for Venmo receipt
 * emails ("John Stone paid $25.00 to your Venmo account.") and reconciles
 * them against the app's unpaid Calcutta bids:
 *   - exact amount + strong name match  -> marks the bid(s) paid via the
 *     app's internal API (one payment may cover a bidder's total unpaid
 *     across teams)
 *   - anything ambiguous                 -> reported for manual review
 *
 * Config (env):
 *   FELLAS_API             base URL, default https://fellas-invitational-live.onrender.com
 *   FELLAS_INTERNAL_SECRET shared secret for /api/internal/* (or FELLAS_SECRET_FILE)
 *   FELLAS_WATCH_STATE     state file path (processed ids, reported items)
 *
 * Output: JSON summary on stdout: { ok, marked: [...], review: [...], errors: [...] }
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = (process.env.FELLAS_API || 'https://fellas-invitational-live.onrender.com').replace(/\/$/, '');
const SECRET = process.env.FELLAS_INTERNAL_SECRET ||
  (process.env.FELLAS_SECRET_FILE ? fs.readFileSync(process.env.FELLAS_SECRET_FILE, 'utf8').trim() : '');
const STATE_FILE = process.env.FELLAS_WATCH_STATE ||
  path.join(os.homedir(), 'workspace/goals/fellas-invitational-scoring-app/hidden_files/venmo-watch-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { processed: {}, reportedReview: [], lastRun: null }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function gmailTriage(query, max = 50) {
  const out = execFileSync('hatch_gws_cli',
    ['gmail', '+triage', '--query', query, '--max', String(max), '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(out).messages || [];
}
function gmailRead(id) {
  const out = execFileSync('hatch_gws_cli',
    ['gmail', '+read', '--id', id, '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const d = JSON.parse(out);
  return (d.body_text || d.body || '').toString();
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Strong name match: identical, or every token of the shorter name is in the longer. */
function namesStrong(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(' '), tb = nb.split(' ');
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every(tok => tok.length > 1 && long.includes(tok));
}

async function api(pathname, opts = {}) {
  const r = await fetch(API + pathname, {
    ...opts,
    headers: { 'X-Internal-Secret': SECRET, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${pathname} -> HTTP ${r.status}`);
  return r.json();
}

/** Pull a short standalone note line from the receipt body (e.g. an emoji or "Fellas Calcutta"). */
function extractNote(body) {
  const lines = body.split('\n').map(l =>
    l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_#>|]/g, '').trim()).filter(Boolean);
  const payIdx = lines.findIndex(l => /paid you/i.test(l));
  for (let i = payIdx + 1; i < Math.min(payIdx + 4, lines.length); i++) {
    const l = lines[i];
    if (l.length <= 80 && !/^https?:/i.test(l) && !/see transaction|money credited|transaction details/i.test(l)) return l;
  }
  return '';
}

async function main() {
  const summary = { ok: true, marked: [], review: [], errors: [] };
  if (!SECRET) { summary.ok = false; summary.errors.push('FELLAS_INTERNAL_SECRET not set'); console.log(JSON.stringify(summary)); process.exit(2); }
  const state = loadState();

  let pending;
  try {
    pending = (await api('/api/internal/calcutta/pending')).pending || [];
  } catch (e) {
    summary.ok = false; summary.errors.push('pending API: ' + e.message);
    console.log(JSON.stringify(summary)); process.exit(2);
  }

  const receipts = gmailTriage('from:venmo@venmo.com subject:paid newer_than:2d', 50)
    .filter(m => !state.processed[m.id] && / paid \$[\d,]+\.\d{2} to your Venmo account\./i.test(m.subject));

  for (const m of receipts) {
    state.processed[m.id] = true;
    const mm = m.subject.match(/^(.+?) paid \$([\d,]+\.\d{2}) to your Venmo account\./i);
    if (!mm) continue;
    const sender = mm[1].trim();
    const cents = Math.round(parseFloat(mm[2].replace(/,/g, '')) * 100);
    let note = '';
    try { note = extractNote(gmailRead(m.id)); } catch { /* note optional */ }

    const unpaid = pending.filter(b => !b._done);
    // 1) single-bid match: same amount + strong name
    let hits = unpaid.filter(b => b.amount_cents === cents && namesStrong(sender, b.name));
    let bidIds = [];
    if (hits.length === 1) {
      bidIds = [hits[0].bid_id];
    } else if (hits.length === 0) {
      // 2) whole-balance match: bidder's total unpaid == payment, strong name
      const byBidder = new Map();
      for (const b of unpaid) {
        const k = normName(b.name);
        if (!byBidder.has(k)) byBidder.set(k, { name: b.name, ids: [], total: 0 });
        const g = byBidder.get(k); g.ids.push(b.bid_id); g.total += b.amount_cents;
      }
      const gb = [...byBidder.values()].find(g => g.total === cents && namesStrong(sender, g.name));
      if (gb) bidIds = gb.ids;
    }
    if (bidIds.length > 0) {
      for (const id of bidIds) {
        try {
          await api('/api/internal/calcutta/mark-paid', { method: 'POST', body: JSON.stringify({ bid_id: id }) });
          const b = unpaid.find(x => x.bid_id === id); if (b) b._done = true;
        } catch (e) { summary.errors.push(`mark-paid ${id}: ${e.message}`); }
      }
      const b0 = unpaid.find(x => x.bid_id === bidIds[0]);
      summary.marked.push({ name: b0 ? b0.name : sender, amount_cents: cents, bids: bidIds.length, note });
    } else {
      const key = `${normName(sender)}|${cents}`;
      summary.review.push({ sender, amount_cents: cents, note, reason: 'no confident bid match', key });
      if (!state.reportedReview.includes(key)) state.reportedReview.push(key);
    }
  }

  // prune processed ids (keep last 500)
  const ids = Object.keys(state.processed);
  if (ids.length > 500) ids.slice(0, ids.length - 500).forEach(id => delete state.processed[id]);
  state.lastRun = new Date().toISOString();
  saveState(state);
  console.log(JSON.stringify(summary));
}

main().catch(e => { console.log(JSON.stringify({ ok: false, marked: [], review: [], errors: [String(e)] })); process.exit(2); });
