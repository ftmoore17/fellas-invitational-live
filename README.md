# Fellas Invitational — Live Scoring (Production)

Real multi-user live scoring app for the Fellas Invitational golf tournament.
Replaces the static prototype with a server-backed app: shared live state,
real auth, and persistent scores.

**Tournament:** August 2027 (currently seeded with the 2026 test tournament for development).

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite via `better-sqlite3` — single file (`data/fellas.db`), zero-config.
  Back up the tournament by copying the file.
- **Live sync:** WebSocket (`ws`) on the same port. Saving scores broadcasts
  `{ type: 'scores_updated', pairing_id, match_no }`; admin changes broadcast
  `{ type: 'tournament_updated' }`. Clients re-fetch the REST read models.
- **Auth:** token sessions in SQLite (survive restarts), httpOnly cookie.
  - **Admin:** username + bcrypt password → full control.
  - **Player:** "claim your name with a PIN" (4-digit, admin-generated per player).
    May enter scores for their own group only.
  - **Spectator:** view-only, unlocked with the tournament spectator code.

## Quick start

```bash
npm install
node server/seed.js        # load the 2026 test tournament (prints PINs + admin pw)
PORT=3000 node server/index.js
```

Seed defaults (change immediately):
- Admin: `admin` / `fellas-admin-2026` (or set `ADMIN_PASSWORD` env when seeding)
- Spectator code: `FELLAS26`
- Player claim PINs are printed by the seed script.

## API

Public: `GET /api/health`, `GET /api/tournament`,
`POST /api/auth/claim {player_id, pin}`, `POST /api/auth/spectator {code}`,
`POST /api/auth/logout`, `GET /api/me`

Read (any signed-in role): `GET /api/leaderboard`, `GET /api/boards/match/:n`
(labeled with its nine: "Front 9"/"Back 9"/"Full 18"; rows carry live `toPar` —
net vs par for holes played, gross vs par for scramble), `GET /api/boards/nine/front`
and `GET /api/boards/nine/back` ("Front 9 Low Net"/"Back 9 Low Net" — individuals
across M1+M4+M6 / M2+M5+M7, scramble excluded), `GET /api/boards/weekend?tier=A` (individuals; sorted by to-par ascending,
to-par tie → higher Stableford),
`GET /api/schedule`, `GET /api/matches/:n`, `GET /api/pairings/:id`,
`GET /api/my/groups` (logged-in player's own groups per match — the Scoring
tab default; partners/opponents, live progress, lock state)

Scoring (player/admin): `POST /api/scores {pairing_id, entries:[{kind, id, hole_no, gross}]}` —
`kind` is `player` (best ball/singles) or `team` (scramble). Last write wins
per hole, with "entered by" attribution. Players may only score their own group.
Hole numbers are validated against the match's segment (9-hole matches: their
nine only; scramble: 1–18). `POST /api/pairings/:id/finalize` — confirms the
scores after all holes are scored for all players; verifies completeness and
locks the pairing (admin can unlock via `PUT /api/admin/pairings/:id`
with `{locked:false}`).

Admin (`/api/admin`, admin role): login, tournaments, teams, players (+PIN
regeneration), courses (ratings/slopes/pars/hole data), matches, pairings CRUD,
`POST /matches/:n/generate-singles` (M6/M7 auto-seed from standings, re-runnable
until locked), `POST /matches/:n/lock`, `PUT /matches/3/scramble` (per-course
team assignment + points scales), prize settings, change-password,
`GET /scores/export` (JSON: every player's gross/net per course, per hole) and
`GET /scores/export.csv` (CSV download, one row per player/course).

## Scoring rules (from SPEC.md)

- Format: Matches 1, 2, 4, 5, 6, 7 are **9 holes** each; Match 3 scramble is
  **18 holes** (the exception). A player's 9-hole net is computed on holes 1-9
  or 10-18 per the match's segment, regardless of starting tee / play order
  (matters for Saturday AM split tees on Love).
- Low Net is tracked per nine: "Front 9 Low Net" (M1+M4+M6) and
  "Back 9 Low Net" (M2+M5+M7) as separate individual boards; scramble excluded.

- Course handicap: `HI × (Slope/113) + (Rating − Par)`, rounded; halved for 9-hole segments.
- Stableford (net): birdie 1, eagle 3, albatross 6, condor 12. Updates live.
- Match play: win 10 / tie 5–5 / loss 0. **MP counts only when that pairing is
  final**; a team's match cell sums completed pairings (dash until one completes).
- Scramble: no handicaps; per-course placement points with USGA scorecard
  playoff (last 9 → 6 → 3 → hole-by-hole back); unbreakable ties split points.
  Overall low-net ranks by score relative to par.
- Weekend low net: player's own net across M1,2,4,5,6,7 (scramble excluded).

## Project structure

```
server/
  index.js        Express + WebSocket server
  db.js           SQLite schema
  scoring.js      Pure scoring engine (handicaps, Stableford, match play, playoffs)
  leaderboards.js Read models (master board, match boards, weekend, schedule, detail)
  auth.js         Sessions, bcrypt, role middleware
  routes.js       Public + scoring API
  admin.js        Admin API (incl. singles generation)
  seed.js         2026 test data
data/             fellas.db (gitignored in real use)
public/           Frontend (Phase 6 — not yet built)
```

## Notes / before August 2027

- UI decisions (Trice):
  - Tabs: Leaderboard, Scoring, Boards, Schedule, Admin — in that order.
  - **Leaderboard tab** keeps its match pairing cards / Match center section
    below the master scoreboard (as in the prototype) — Trice explicitly
    wants those there.
  - **Boards tabs** (Match Low Net, Weekend Low Net, Front 9 / Back 9 Low Net)
    show board content only — **no Match center section** below them
    (removed 2026-10-13).
  - No popups or modal detail views anywhere — details expand inline.
    Explicit exceptions (Trice): the Admin login form, and the **"Confirm
    scores" popup**: when every hole is scored for every player in the group
    (9 holes for 9-hole matches, 18 for the scramble), the Scoring tab shows
    a popup with a summary of the entered scores and **Confirm / Back to edit**
    options. Confirm calls `POST /api/pairings/:id/finalize` and locks the
    pairing; Back to edit closes the popup and resumes scoring.
  - **Scoring flow** (Trice, 2026-10-13): the scorer **manually picks which
    match to score** each time — the app must NOT auto-advance to the next
    match after completing one. The **match selector (Match 1–7) is persistent
    and always accessible on the Scoring tab** — the scorer can see and switch
    matches at all times, never locked into a flow.
  - **Scoring default** (Trice, 2026-10-13): when a player is logged in
    (claimed identity), the Scoring tab defaults to **their own group**
    (via `GET /api/my/groups`) — never a hardcoded demo group. The match
    selector stays for switching.
  - **Hole navigation** (Trice, 2026-10-13): 9-hole matches (1, 2, 4, 5, 6, 7)
    **stop at hole 9** — no advancing to hole 10+. Only the 18-hole Match 3
    scramble goes to 18. Enforced by the API as well as the UI.
  - Mobile-first; verify every screen at 390px. Title Case for headings.
  - Stableford everywhere (never "bonus points"). No "awaiting scores"
    subtitles; standings as prominent ordinals (1st, 2nd, …) with "X back".
- Hole pars/stroke-indexes are **placeholders** — verify against real Barefoot
  scorecards in Admin (Courses).
- Change the admin password after first login (`POST /api/admin/change-password`).
- Regenerate player PINs and set a fresh spectator code for the 2027 field.
- Create the 2027 tournament via the Admin API; the 2026 data is test-only.
- For production hosting, run behind HTTPS and set `COOKIE_SECURE=1`.
