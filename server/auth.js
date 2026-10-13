/**
 * Auth — token sessions stored in SQLite (survive restarts).
 *
 * Roles:
 *  - admin:     username + bcrypt password. Full control.
 *  - player:    claims their name with a 4-digit PIN (no email/password).
 *  - spectator: view-only, unlocked with the tournament's spectator code.
 *
 * The session token is an httpOnly cookie. Scores may be entered by
 * players (for their group) or admins. Spectators are read-only.
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('./db');

const COOKIE_NAME = 'fellas_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession({ role, adminId = null, playerId = null, tournamentId }) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, role, admin_id, player_id, tournament_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, role, adminId, playerId, tournamentId, expiresAt);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

/** Attach req.session (or null) from the cookie. */
function sessionMiddleware(req, res, next) {
  req.session = getSession(req.cookies[COOKIE_NAME]);
  next();
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    // secure: true in production behind HTTPS (set via env)
    secure: process.env.COOKIE_SECURE === '1',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

/** Require any authenticated role (admin, player, spectator). */
function requireAuth(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/** Require admin role. */
function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin required' });
  }
  next();
}

/**
 * Require player or admin (score entry). Spectators are read-only.
 * Attaches req.playerId when the session is a claimed player.
 */
function requireScorer(req, res, next) {
  if (!req.session || (req.session.role !== 'player' && req.session.role !== 'admin')) {
    return res.status(403).json({ error: 'Score entry requires a claimed player or admin' });
  }
  next();
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  COOKIE_NAME,
  createSession,
  getSession,
  destroySession,
  sessionMiddleware,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireAdmin,
  requireScorer,
  hashPassword,
  verifyPassword,
};
