// A small stand-in for api.simkl.com (and the test playlist), for APL TV's Simkl tests.
// State is in memory; /__log lists the requests the app made, /__do changes the library "from another app".
"use strict";
const http = require("http");
const PORT = +process.env.PORT || 8090;

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
let clock = Date.now();
function tick() { clock = Math.max(clock + 1000, Date.now()); return iso(clock); }

let nextId = 900000;
const lib = { movies: [], shows: [], anime: [] };
let playback = [];
const acts = {
  all: null, settings: { all: null },
  tv_shows: { all: null, rated_at: null, playback: null, plantowatch: null, watching: null, completed: null, hold: null, dropped: null, removed_from_list: null },
  anime: { all: null, rated_at: null, playback: null, plantowatch: null, watching: null, completed: null, hold: null, dropped: null, removed_from_list: null },
  movies: { all: null, rated_at: null, playback: null, plantowatch: null, completed: null, dropped: null, removed_from_list: null },
};
function bump(sec, bucket) { const t = tick(); acts[sec][bucket] = t; acts[sec].all = t; acts.all = t; return t; }
function secOf(type) { return type === "movies" ? "movies" : type === "anime" ? "anime" : "tv_shows"; }

function movie(id, title, year, tmdb, imdb, status, watchedAgoDays) {
  const t = iso(Date.now() - (watchedAgoDays || 0) * DAY);
  const row = { added_to_watchlist_at: t, last_watched_at: status === "completed" ? t : null, user_rating: null, status,
    movie: { title, year, ids: { simkl: id, slug: title.toLowerCase(), tmdb: tmdb || undefined, imdb: imdb || undefined } }, _mod: tick() };
  lib.movies.push(row); return row;
}
function show(id, title, year, tmdb, status, eps, watchedAgoDays, next) {
  const t = iso(Date.now() - (watchedAgoDays || 0) * DAY);
  const seasons = {};
  (eps || []).forEach(([s, e]) => { (seasons[s] = seasons[s] || []).push({ number: e, watched_at: t }); });
  const row = { added_to_watchlist_at: t, last_watched_at: eps && eps.length || status === "completed" ? t : null, status, last_watched: null, next_to_watch: next || null,
    show: { title, year, ids: { simkl: id, tmdb: tmdb || undefined } }, seasons: Object.keys(seasons).map((s) => ({ number: +s, episodes: seasons[s] })), _mod: tick() };
  lib.shows.push(row); return row;
}

// ---- the library "on Simkl" before linking ----
movie(101, "Inception", 2010, "27205", "tt1375666", "completed", 5);
movie(102, "The Matrix", 1999, "603", "tt0133093", "plantowatch");
movie(103, "Dune", 2021, "438631", "tt1160419", "completed", 3);
movie(104, "The Godfather", 1972, "238", "tt0068646", "plantowatch");
movie(105, "Arrival", 2016, "329865", "tt2543164", "plantowatch");
show(201, "Breaking Bad", 2008, "1396", "watching", [[1, 1], [1, 2], [1, 3]], 2, "S01E04");
show(202, "The Office", 2005, "2316", "completed", [], 40);
show(203, "Dark", 2017, "70523", "watching", [[1, 1]], 1, "S01E02");
playback.push({ id: 5001, progress: 40, paused_at: iso(Date.now() - DAY), type: "movie", movie: { title: "Arrival", year: 2016, ids: { simkl: 105, tmdb: "329865" } } });
playback.push({ id: 5002, progress: 30, paused_at: iso(Date.now() - 3600000), type: "episode", episode: { season: 1, number: 2, title: "Lies" }, show: { title: "Dark", year: 2017, ids: { simkl: 203, tmdb: "70523" } } });
["movies", "tv_shows"].forEach((s) => { ["all", "plantowatch", "completed", "playback"].forEach((b) => { acts[s][b] = tick(); }); });
acts.tv_shows.watching = tick(); acts.all = tick();

// ---- tokens ----
let failPause = 0;
let polls = 0, access = "", refresh = "rt-1", gen = 0;
function newToken() { gen++; access = "at-" + gen; return { access_token: access, token_type: "Bearer", expires_in: 604800, refresh_token: refresh, scope: "media:read media:write" }; }

const log = [];
function find(type, ids, title, year) {
  return lib[type].find((r) => {
    const o = r.movie || r.show, i = o.ids;
    if (ids && ids.simkl && +ids.simkl === i.simkl) return true;
    if (ids && ids.tmdb && i.tmdb && String(ids.tmdb) === String(i.tmdb)) return true;
    if (ids && ids.imdb && i.imdb && ids.imdb === i.imdb) return true;
    return !(ids && (ids.simkl || ids.tmdb || ids.imdb)) && title && o.title.toLowerCase() === String(title).toLowerCase() && (!year || !o.year || Math.abs(o.year - year) <= 1);
  });
}
function create(type, it) {
  const o = { title: it.title || "?", year: it.year || 0, ids: Object.assign({ simkl: nextId++ }, it.ids || {}) };
  const row = { added_to_watchlist_at: tick(), last_watched_at: null, status: null, _mod: tick() };
  if (type === "movies") row.movie = o; else { row.show = o; row.seasons = []; }
  lib[type].push(row); return row;
}

function history(b, remove) {
  const out = { added: { movies: 0, shows: 0, episodes: 0 }, deleted: { movies: 0, shows: 0, episodes: 0 }, not_found: { movies: [], shows: [], episodes: [] } };
  (b.movies || []).forEach((it) => {
    let r = find("movies", it.ids, it.title, it.year);
    if (remove) {
      if (!r) { out.not_found.movies.push(it); return; }
      lib.movies.splice(lib.movies.indexOf(r), 1); out.deleted.movies++; bump("movies", "removed_from_list"); return;
    }
    if (!r) r = create("movies", it);
    r.status = "completed"; r.last_watched_at = it.watched_at || tick(); r._mod = tick(); out.added.movies++; bump("movies", "completed");
  });
  (b.shows || []).forEach((it) => {
    let r = find("shows", it.ids, it.title, it.year);
    if (remove && !r) { out.not_found.shows.push(it); return; }
    if (remove && !it.seasons) { lib.shows.splice(lib.shows.indexOf(r), 1); out.deleted.shows++; bump("tv_shows", "removed_from_list"); return; }
    if (!r) r = create("shows", it);
    (it.seasons || []).forEach((s) => {
      let season = r.seasons.find((x) => x.number === s.number);
      if (!season) { season = { number: s.number, episodes: [] }; r.seasons.push(season); }
      (s.episodes || []).forEach((e) => {
        const at = season.episodes.findIndex((x) => x.number === e.number);
        if (remove) { if (at >= 0) { season.episodes.splice(at, 1); out.deleted.episodes++; } }
        else if (at < 0) { season.episodes.push({ number: e.number, watched_at: e.watched_at || tick() }); out.added.episodes++; }
      });
    });
    if (!remove) { r.status = r.status === "completed" ? "completed" : "watching"; r.last_watched_at = tick(); }
    else if (r.status === "completed") r.status = "watching";
    r._mod = tick(); bump("tv_shows", "watching");
  });
  return out;
}

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, *", "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS" });
  res.end(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
}
function clean(row) { const c = Object.assign({}, row); delete c._mod; return c; }

const PLAYLIST = (base) => {
  const L = ["#EXTM3U"];
  const add = (title, path, group) => { L.push('#EXTINF:-1 group-title="' + group + '",' + title); L.push(base + path); };
  add("Inception (2010)", "/v/movie/1/inception.mp4", "Movies EN");
  add("The Matrix (1999)", "/v/movie/1/matrix.mp4", "Movies EN");
  add("Dune (2021)", "/v/movie/1/dune2021.mp4", "Movies EN");
  add("Dune (1984)", "/v/movie/1/dune1984.mp4", "Movies EN");
  add("Arrival (2016)", "/v/movie/1/arrival.mp4", "Movies EN");
  add("Parasite (2019)", "/v/movie/1/parasite.mp4", "Movies EN");
  add("FR - Le Parrain (1972)", "/v/movie/1/parrain.mp4", "Films FR");
  for (let s = 1; s <= 2; s++) for (let e = 1; e <= 7; e++) add("Breaking Bad S0" + s + "E0" + e, "/v/series/1/bb" + s + e + ".mp4", "Series EN");
  for (let e = 1; e <= 6; e++) add("The Office S01E0" + e, "/v/series/1/office" + e + ".mp4", "Series EN");
  for (let e = 1; e <= 4; e++) add("Dark S01E0" + e, "/v/series/1/dark" + e + ".mp4", "Series EN");
  add("Channel One", "/v/live/1.ts", "News");
  return L.join("\n") + "\n";
};

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "OPTIONS") return send(res, 204);
    const p = u.pathname;
    if (p === "/playlist.m3u") return send(res, 200, PLAYLIST("http://127.0.0.1:" + PORT), "audio/x-mpegurl");
    if (p === "/__log") return send(res, 200, log);
    if (p === "/__state") return send(res, 200, { lib, playback, acts });
    if (p === "/__do") {
      const what = u.searchParams.get("what");
      if (what === "unwatch-dune") { const r = find("movies", { simkl: 103 }); lib.movies.splice(lib.movies.indexOf(r), 1); bump("movies", "removed_from_list"); }
      if (what === "unwatch-arrival") { const r = find("movies", { simkl: 105 }); if (r) { lib.movies.splice(lib.movies.indexOf(r), 1); bump("movies", "removed_from_list"); } }
      if (what === "ptw-godfather-off") { const r = find("movies", { simkl: 104 }); lib.movies.splice(lib.movies.indexOf(r), 1); bump("movies", "removed_from_list"); }
      if (what === "ptw-dune84") { movie(106, "Dune", 1984, "841", "tt0087182", "plantowatch")._mod = tick(); bump("movies", "plantowatch"); }
      if (what === "office-unwatch-e3") { const r = find("shows", { simkl: 202 }); r.status = "watching"; r.seasons = [{ number: 1, episodes: [1, 2, 4, 5, 6].map((n) => ({ number: n, watched_at: iso(Date.now() - 40 * DAY) })) }]; r._mod = tick(); bump("tv_shows", "watching"); }
      if (what === "expire") access = "expired";
      if (what === "forget-dune84") { lib.movies = lib.movies.filter((r) => !(r.movie.title === "Dune" && r.movie.year === 1984)); bump("movies", "removed_from_list"); }
      if (what === "fail-next-pause") failPause = 1;
      if (what === "clear-playback") { playback = []; bump("movies", "playback"); bump("tv_shows", "playback"); }
      return send(res, 200, { ok: true, what });
    }
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
    const entry = { m: req.method, p, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization || "", ct: req.headers["content-type"] || "", body, at: Date.now() };
    log.push(entry);
    if (!u.searchParams.get("client_id") || u.searchParams.get("app-name") !== "apl-tv" || !u.searchParams.get("app-version")) return send(res, 400, { error: "client_id_failed" });
    const form = Object.fromEntries(new URLSearchParams(typeof raw === "string" ? raw : ""));
    if (p === "/oauth2/device") return send(res, 200, { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://simkl.com/pin", verification_uri_complete: "https://simkl.com/pin?user_code=ABCD-1234", expires_in: 900, interval: 5 });
    if (p === "/oauth2/token") {
      if (form.grant_type === "refresh_token") return form.refresh_token === refresh ? send(res, 200, newToken()) : send(res, 400, { error: "invalid_grant" });
      if (form.device_code !== "dev-1") return send(res, 400, { error: "invalid_grant" });
      polls++;
      return polls < 2 ? send(res, 400, { error: "authorization_pending" }) : send(res, 200, newToken());
    }
    if (p === "/oauth2/revoke") { refresh = "revoked"; return send(res, 200, {}); }
    if (req.headers.authorization !== "Bearer " + access) return send(res, 401, { error: "user_token_failed" });
    if (p === "/users/settings") return send(res, 200, { user: { name: "tester" }, account: { id: 42, type: "free" } });
    if (p === "/sync/activities") return send(res, 200, acts);
    if (p.indexOf("/sync/all-items") === 0) {
      const type = p.split("/")[3];
      const from = u.searchParams.get("date_from"), idsOnly = u.searchParams.get("extended") === "simkl_ids_only";
      const out = {};
      ["movies", "shows", "anime"].forEach((t) => {
        if (type && type !== t) return;
        let rows = lib[t].filter((r) => r.status && (!from || r._mod > from));
        if (idsOnly) rows = rows.map((r) => (t === "movies" ? { movie: { ids: { simkl: r.movie.ids.simkl } } } : { show: { ids: { simkl: r.show.ids.simkl } } }));
        else rows = rows.map(clean);
        if (rows.length) out[t] = rows;
      });
      return send(res, 200, out);
    }
    if (p === "/sync/playback") return send(res, 200, playback);
    if (p.indexOf("/sync/playback/") === 0 && req.method === "DELETE") {
      const id = +p.split("/")[3], before = playback.length;
      playback = playback.filter((x) => x.id !== id);
      if (before === playback.length) return send(res, 404, { error: "empty" });
      bump("movies", "playback"); bump("tv_shows", "playback");
      return send(res, 204);
    }
    if (p === "/sync/history") return send(res, 201, history(body || {}, false));
    if (p === "/sync/history/remove") return send(res, 200, history(body || {}, true));
    if (p === "/sync/add-to-list") {
      const out = { added: { movies: [], shows: [] }, not_found: { movies: [], shows: [] } };
      ["movies", "shows"].forEach((t) => (body[t] || []).forEach((it) => {
        if (!it.to) return send(res, 400, { error: "empty_field" });
        let r = find(t, it.ids, it.title, it.year) || create(t, it);
        r.status = it.to; r._mod = tick(); out.added[t].push({ to: it.to }); bump(secOf(t), it.to);
      }));
      return send(res, 201, out);
    }
    if (p.indexOf("/scrobble/") === 0) {
      const action = p.split("/")[2], b = body || {};
      if (action === "pause" && failPause) { failPause = 0; return send(res, 503, { error: "busy" }); }
      if (action === "stop" && b.progress >= 80) {
        const sid = (b.movie || b.show).ids.simkl;
        playback = playback.filter((x) => (x.movie || x.show).ids.simkl !== sid || (b.episode && x.episode && (x.episode.season !== b.episode.season || x.episode.number !== b.episode.number)));
        bump(b.movie ? "movies" : "tv_shows", "playback");
        if (b.movie) history({ movies: [Object.assign({}, b.movie)] }, false);
        else history({ shows: [Object.assign({}, b.show, { seasons: [{ number: b.episode.season, episodes: [{ number: b.episode.number }] }] })] }, false);
        return send(res, 201, { id: 1, action: "scrobble", progress: b.progress });
      }
      if (action === "pause" || action === "stop") {
        const o = b.movie || b.show, ids = o.ids || {};
        playback.push({ id: nextId++, progress: Math.round(b.progress), paused_at: tick(), type: b.movie ? "movie" : "episode", episode: b.episode, movie: b.movie ? o : undefined, show: b.show ? o : undefined });
        bump(b.movie ? "movies" : "tv_shows", "playback");
      }
      return send(res, 201, { id: 1, action: action === "stop" ? "pause" : action, progress: b.progress });
    }
    send(res, 404, { error: "not_found" });
  });
}).listen(PORT, () => console.log("mock simkl on " + PORT));
