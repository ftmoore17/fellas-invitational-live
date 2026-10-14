/**
 * Database layer — SQLite via better-sqlite3.
 *
 * Single-file database (data/fellas.db), zero-config. Perfect for a
 * 48-player tournament: the whole event fits in one file that can be
 * backed up by copying it.
 *
 * All timestamps stored as ISO strings (UTC).
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'fellas.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
-- One row per tournament edition (2026 test, 2027 live, ...)
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup',        -- setup | live | complete
  spectator_code TEXT,                          -- view-only access code
  prize_settings TEXT,                          -- JSON: {first, second, ...}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Color-named teams (Orange, Green, ...). Count is configurable (up to 12).
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Players belong to a team; tier A/B/C/D assigned by handicap rank.
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  ghin_index REAL NOT NULL DEFAULT 0,
  tier TEXT,                                    -- A | B | C | D
  claim_pin TEXT                                -- 4-digit PIN to claim this player
);

-- Admin logins (bcrypt hashes). Real auth, unlike the prototype's client PIN.
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Courses with Black (handicap rounds) and White (scramble) tee data.
-- holes_json: [{par, si}, ...] x18 — stroke index 1..18, editable placeholders.
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                           -- Dye, Fazio, Love, Norman
  black_rating REAL, black_slope INTEGER, black_par INTEGER, black_yardage INTEGER,
  white_rating REAL, white_slope INTEGER, white_par INTEGER, white_yardage INTEGER,
  holes_json TEXT NOT NULL DEFAULT '[]'
);

-- The 7 scoring segments of the tournament.
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_no INTEGER NOT NULL,                    -- 1..7
  label TEXT NOT NULL,                          -- "Match 1 · Friday AM Front Nine"
  day TEXT,                                     -- Friday | Saturday
  format TEXT NOT NULL,                         -- bestball | scramble | singles
  segment TEXT NOT NULL,                        -- front | back | full
  status TEXT NOT NULL DEFAULT 'scheduled',     -- scheduled | live | final
  locked INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tournament_id, match_no)
);

-- A pairing = one contest within a match.
-- unit_type: 'pair' (2v2 best ball), 'team' (scramble foursome), 'single' (1v1).
CREATE TABLE IF NOT EXISTS pairings (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  tee_time TEXT,
  course_id INTEGER REFERENCES courses(id),
  course_label TEXT,                            -- e.g. "Fazio Back"
  unit_type TEXT NOT NULL,                      -- pair | team | single
  side_a_team_id INTEGER REFERENCES teams(id),
  side_b_team_id INTEGER REFERENCES teams(id),
  locked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing_players (
  id INTEGER PRIMARY KEY,
  pairing_id INTEGER NOT NULL REFERENCES pairings(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  side TEXT NOT NULL,                           -- A | B
  UNIQUE(pairing_id, player_id)
);

-- Individual hole scores (best ball + singles). Last write wins per hole.
CREATE TABLE IF NOT EXISTS hole_scores (
  id INTEGER PRIMARY KEY,
  pairing_id INTEGER NOT NULL REFERENCES pairings(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  hole_no INTEGER NOT NULL,                     -- 1..18
  gross INTEGER NOT NULL,
  entered_by TEXT,                              -- display name of scorer
  entered_by_player_id INTEGER REFERENCES players(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pairing_id, player_id, hole_no)
);

-- Scramble team scores (one gross per hole per team, no handicaps).
CREATE TABLE IF NOT EXISTS scramble_scores (
  id INTEGER PRIMARY KEY,
  pairing_id INTEGER NOT NULL REFERENCES pairings(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hole_no INTEGER NOT NULL,
  gross INTEGER NOT NULL,
  entered_by TEXT,
  entered_by_player_id INTEGER REFERENCES players(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pairing_id, team_id, hole_no)
);

-- Per-course scramble setup: which course hosts which teams + points scale.
CREATE TABLE IF NOT EXISTS scramble_courses (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  points_scale TEXT NOT NULL,                   -- JSON array, e.g. [40,30,25,20,15,10]
  UNIQUE(match_id, course_id)
);

-- Token sessions (persistent across restarts, unlike memory stores).
-- role: admin | player | spectator
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Calcutta auction bids (Thursday night). One bid per bidder per team;
-- the bidder's share of the team = amount / team total.
-- Bidders are players (bidder_player_id) or spectators who typed a name
-- (bidder_name with NULL bidder_player_id).
CREATE TABLE IF NOT EXISTS calcutta_bids (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  bidder_player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
  bidder_name TEXT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 1,               -- 1 = Venmo verified by admin
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tournament_id, bidder_player_id, team_id),
  CHECK ((bidder_player_id IS NULL) != (bidder_name IS NULL))
);
`;

db.exec(SCHEMA);

// Lightweight column migrations for tables created before the column existed.
const _tcols = db.prepare(`PRAGMA table_info(tournaments)`).all().map(c => c.name);
if (!_tcols.includes('calcutta_payouts')) {
  // JSON: {"1":100,"2":0,"3":0} — % of the (paid) pool to 1st/2nd/3rd place teams (winner-take-all default).
  db.exec(`ALTER TABLE tournaments ADD COLUMN calcutta_payouts TEXT`);
}
if (!_tcols.includes('venmo_username')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN venmo_username TEXT`);
}
if (!_tcols.includes('calcutta_open')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN calcutta_open INTEGER DEFAULT 1`);
}
// Spectator Calcutta bids: typed bidder_name with NULL bidder_player_id.
// Rebuilds calcutta_bids to relax the NOT NULL on bidder_player_id.
const _bcols = db.prepare(`PRAGMA table_info(calcutta_bids)`).all().map(c => c.name);
if (!_bcols.includes('bidder_name')) {
  db.exec(`
    CREATE TABLE calcutta_bids_new (
      id INTEGER PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      bidder_player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      bidder_name TEXT,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      paid INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tournament_id, bidder_player_id, team_id),
      CHECK ((bidder_player_id IS NULL) != (bidder_name IS NULL))
    );
    INSERT INTO calcutta_bids_new (id, tournament_id, bidder_player_id, team_id, amount_cents, paid, created_at)
      SELECT id, tournament_id, bidder_player_id, team_id, amount_cents, paid, created_at FROM calcutta_bids;
    DROP TABLE calcutta_bids;
    ALTER TABLE calcutta_bids_new RENAME TO calcutta_bids;
  `);
}

module.exports = db;
