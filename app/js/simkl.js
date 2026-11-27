/* ============================================================
   simkl.js: your Simkl account (simkl.com), kept the same as APL TV in
   both directions.
   - Linked with a code shown on the screen, typed on simkl.com/pin (no
     password on the TV). Simkl's sign-in for TVs, version 2: a key for 7
     days, renewed by itself with a second key that lasts 180 days.
   - Watched: a movie or an episode finished here, or marked by hand, goes
     into your Simkl history; what Simkl says you watched, on any app, gets
     its tick here (js/data.js watched). Marked unwatched on one side:
     unwatched on the other.
   - My List <-> your Plan to Watch list on Simkl.
   - Continue Watching: where you stop here is sent to Simkl, where you
     paused in another app comes here, and the next episode of the series
     you watch on Simkl shows as Up Next.
   Simkl's rules for apps (api.simkl.org/guides/sync): its activity times
   are checked when APL TV starts, comes back to the front or Home opens,
   at most every 15 minutes, and only what changed is asked (one small
   request when nothing did). Changes made here wait in a queue, kept when
   APL TV closes, and go out in a few grouped requests, one per second at
   most.
   A Simkl title is found in your catalog by its TMDB id, else by its title
   and year (and TMDB's title in your language when you have a TMDB key).
   What APL TV keeps of your Simkl library is in IndexedDB ("simkl:mirror").
   ============================================================ */
(function (global) {
    "use strict";

    var TV = global.TV, S = TV.smart, T = TV.t, D = TV.data;
    /* APL TV's Client ID: an app of the type "TV, devices & command line" made at simkl.com/settings/developer
       (free, no secret). js/keys.local.js (TV_KEYS.simkl) or Settings › Simkl can give another one. */
    var CLIENT_ID = "";
    // a test server instead of Simkl's, only while developing (like plexTv in js/media.js)
    var TEST = (TV.PREVIEW || TV.DEV) && TV.load("simklTest", "") || "";
    var API = TEST || "https://api.simkl.com";
    var POLL_MS = 15 * 60000;            // Simkl asks apps to check at most every 15 to 30 minutes
    var FAIL_MS = 5 * 60000;             // no answer: not asked again before 5 minutes
    var FULL_MS = 7 * 86400000;          // the whole library asked again once a week, in case anything drifted
    var SLACK = 2 * 60000;               // the TV's clock and Simkl's may differ a little
    var MKEY = "simkl:mirror";
    var RECENT_MS = 30 * 86400000, UPNEXT_MS = 60 * 86400000;

    function noop() {}
    function clientId() { return String((global.TV_KEYS && global.TV_KEYS.simkl) || TV.load("simklClientId", "") || CLIENT_ID || "").trim(); }
    function account() { return TV.load("simkl", null); }
    function linked() { var a = account(); return !!(a && a.rt && !a.lost && clientId()); }
    /* Settings › Simkl: what is kept the same (Watched, List, Resume), all on at first */
    function wants(what) { return linked() && TV.pref("simkl" + what) !== false; }
    function ms(s) { var t = s ? Date.parse(s) : 0; return t > 0 ? t : 0; }
    function iso(t) { try { return new Date(t || Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z"); } catch (e) { return undefined; } }
    function qs(o) { return Object.keys(o).filter(function (k) { return o[k] !== undefined && o[k] !== null && o[k] !== ""; }).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&"); }
    /* Every request names the app (Simkl requires it since April 2026): in the address, which needs no extra header */
    function appQ(q) { var o = {}; Object.keys(q || {}).forEach(function (k) { o[k] = q[k]; }); o.client_id = clientId(); o["app-name"] = "apl-tv"; o["app-version"] = TV.VERSION || "1"; return o; }
    function json(r) { if (!r || !r.text) return null; try { return JSON.parse(r.text); } catch (e) { return null; } }
    function failure(r, what) {
        var j = json(r) || {}, e = new Error((what || "simkl") + ": " + (r.status ? "HTTP " + r.status : "no answer") + (j.error ? " " + j.error : ""));
        e.status = r.status || 0; e.code = j.error || ""; return e;
    }
    function sequence(items, fn) { return items.reduce(function (p, it) { return p.then(function () { return fn(it); }); }, Promise.resolve()); }

    /* ---------- requests ---------- */
    /* An old LG whose browser refuses JSON sent across sites: the same JSON, sent as text (no extra permission to ask).
       Only when Simkl answered a moment ago (the network works: it is the screen that refused) */
    var plainBody = false, answeredAt = 0;
    function raw(method, path, q, body, token) {
        var h = {}, u = API + path + "?" + qs(appQ(q)), hasBody = body !== undefined && body !== null, plain = plainBody;
        if (token) h.Authorization = "Bearer " + token;
        if (hasBody) h["Content-Type"] = plain ? "text/plain" : "application/json";
        return TV.http(u, { method: method, headers: h, body: hasBody ? JSON.stringify(body) : null, timeout: 30000 }).then(function (r) {
            if (r.status !== 0) {
                answeredAt = Date.now();
                if (plain && (r.status === 400 || r.status === 415)) plainBody = false;      // Simkl wants JSON after all
                return r;
            }
            // the screen refused to read the answer: a read through the helper service, a write once more as text
            if (method === "GET" && TV.helper && TV.helper.sget) {
                return TV.helper.sget(u, token ? { authorization: "Bearer " + token, accept: "application/json" } : { accept: "application/json" }, 30000)
                    .then(function (t) { answeredAt = Date.now(); return { status: 200, text: t }; }, function (e) { return { status: e.status || 0, text: e.body || "" }; });
            }
            if (hasBody && !plain && Date.now() - answeredAt < 120000) { plainBody = true; TV.log("simkl: JSON refused by the screen, sent as text"); return raw(method, path, q, body, token); }
            return r;
        });
    }
    function form(path, o) {
        return TV.http(API + path + "?" + qs(appQ()), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs(o), timeout: 20000 });
    }
    function saveToken(j) {
        var a = account() || {};
        a.at = j.access_token;
        if (j.refresh_token) a.rt = j.refresh_token;
        a.exp = Date.now() + (j.expires_in || 604800) * 1000;
        if (j.scope) a.scope = j.scope;
        a.lost = false;
        TV.save("simkl", a);
        return a;
    }
    /* Simkl refused the second key (unlinked on simkl.com, or not used for 180 days): Settings offers to link again */
    function lost() {
        var a = account();
        if (!a || a.lost) return;
        a.lost = true; a.at = "";
        TV.save("simkl", a);
        TV.log("simkl: the link was refused, link the screen again in Settings");
        D.resumeChanged();
    }
    /* A fresh key, one at a time: a key renewed twice at once would cut off the first one */
    var renewing = null;
    function renew() {
        if (renewing) return renewing;
        var a = account();
        if (!a || !a.rt) return Promise.reject(new Error("simkl: not linked"));
        renewing = form("/oauth2/token", { grant_type: "refresh_token", client_id: clientId(), refresh_token: a.rt }).then(function (r) {
            var j = json(r) || {};
            if (r.status === 200 && j.access_token) return saveToken(j).at;
            if (r.status === 400 || r.status === 401) { if (j.error === "invalid_grant" || j.error === "invalid_client") lost(); }
            throw failure(r, "renew");
        });
        renewing.then(function () { renewing = null; }, function () { renewing = null; });
        return renewing;
    }
    function token() {
        var a = account();
        if (!a || !a.rt || a.lost) return Promise.reject(new Error("simkl: not linked"));
        if (a.at && a.exp > Date.now() + 60000) return Promise.resolve(a.at);
        return renew();
    }
    function api(method, path, q, body) {
        return token().then(function (t) {
            return raw(method, path, q, body, t).then(function (r) { return r.status === 401 ? renew().then(function (t2) { return raw(method, path, q, body, t2); }) : r; });
        }).then(function (r) {
            if (r.status === 204) return null;
            if (r.status >= 200 && r.status < 300) return json(r);
            if (r.status === 409 && path.indexOf("/scrobble/") === 0) return json(r) || {};      // already counted within the hour: done
            if (r.status === 401) lost();
            throw failure(r, method + " " + path);
        });
    }
    /* Writes one after the other, a little more than a second apart (Simkl: 1 write per second) */
    var lastWrite = 0, writes = Promise.resolve();
    function write(method, path, body) {
        var p = writes.then(function () {
            var wait = Math.max(0, lastWrite + 1100 - Date.now());
            return new Promise(function (res) { setTimeout(res, wait); });
        }).then(function () { lastWrite = Date.now(); return api(method, path, null, body); });
        writes = p.then(noop, noop);
        return p;
    }
    /* Not worth trying again: refused for good (a wrong request); the rest (network, busy, throttled) waits */
    function retryable(e) { return !e.status || e.status >= 500 || e.status === 412 || e.status === 429 || e.status === 401 || e.code === "rate_limit"; }

    /* ---------- linking the screen: a code typed on simkl.com/pin ---------- */
    function pin() {
        if (!clientId()) return Promise.reject(new Error(T("APL TV has no Simkl Client ID yet. Add one in Settings › Simkl.")));
        return form("/oauth2/device", { client_id: clientId(), scope: "media:read media:write" }).then(function (r) {
            var j = json(r) || {};
            if (r.status === 200 && j.device_code) {
                return { device: j.device_code, code: j.user_code, url: j.verification_uri || "https://simkl.com/pin", full: j.verification_uri_complete || j.verification_uri || "https://simkl.com/pin",
                         expires: (j.expires_in || 900) * 1000, every: Math.max(5, j.interval || 5) * 1000 };
            }
            if (r.status === 401) throw new Error(T("Simkl does not accept this Client ID. It must be an app of the type “TV, devices & command line”."));
            throw new Error(T("Simkl does not answer right now ({e}).", { e: j.error_description || j.error || (r.status ? "HTTP " + r.status : "no answer") }));
        });
    }
    /* "wait", "slow" (asked too often), "expired", or "ok" once linked */
    function check(p) {
        return form("/oauth2/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId(), device_code: p.device }).then(function (r) {
            var j = json(r) || {};
            if (r.status === 200 && j.access_token) return linkWith(j).then(function () { return "ok"; });
            if (!r.status || j.error === "authorization_pending") return "wait";
            if (j.error === "slow_down") return "slow";
            if (j.error === "expired_token" || j.error === "access_denied") return "expired";
            throw failure(r, "link");
        });
    }
    /* What APL TV's own history knew of a Simkl library (js/data.js sk): forgotten when the link changes, so another
       account's library never unticks it */
    function forgetMarks() {
        var r = D.resumes(), marks = {};
        Object.keys(r).forEach(function (k) { if (r[k] && r[k].sk) marks[k] = 0; });
        D.simklResumes([], marks);
    }
    function linkWith(j) {
        var before = account();
        TV.save("simkl", { at: "", rt: "", exp: 0 });
        var a = saveToken(j);
        a.linkedAt = Date.now();
        TV.save("simkl", a);
        M = empty(); reindex(); TV.idb.del(MKEY);
        forgetMarks();
        return api("GET", "/users/settings").then(function (s) {
            var b = account();
            if (s && s.user) b.user = s.user.name || "";
            if (s && s.account) { b.uid = s.account.id || 0; b.plan = s.account.type || ""; }
            TV.save("simkl", b);
        }).catch(function (e) { TV.log("simkl user: " + e.message); }).then(function () {
            // the same account linked again: the changes still waiting go out; another one: nothing of the old one is kept
            var b = account();
            if (!(before && before.uid && before.uid === b.uid)) { TV.drop("simklOut"); TV.drop("simklList"); }
            else TV.log("simkl: the same account linked again");
            TV.log("simkl: linked" + (account().scope && account().scope.indexOf("media:write") < 0 ? " (read only)" : ""));
            lastCheck = 0;
            sync(true);
        });
    }
    function unlink() {
        var a = account();
        if (a && a.rt) form("/oauth2/revoke", { client_id: clientId(), token: a.rt }).catch(noop);
        TV.drop("simkl"); TV.drop("simklOut"); TV.drop("simklList");
        M = empty(); reindex(); TV.idb.del(MKEY);
        forgetMarks();
        TV.log("simkl: unlinked");
        D.resumeChanged();
    }

    /* ---------- what APL TV keeps of your Simkl library ----------
       items: "m<simkl id>" (movie) or "s<simkl id>" (series, anime too):
         t title, y year, tm TMDB id, im IMDb id, tv TVDB id, a anime, st status (plantowatch, watching, completed,
         hold, dropped), w last watched (ms), l added to the list (ms), nx next episode ("S01E04"), eps watched
         episodes {"1:4": ms}
       play: paused in an app: { id, p %, at ms, g "m"|"s", k item key, tm, im, t, y, se, en }
       snap: Simkl's activity times at the last pull; at: when; full: when the whole library was last asked */
    var M = null, loading = null, ver = 0, IX = null;
    function empty() { return { v: 1, snap: null, items: {}, play: [], at: 0, full: 0, seeded: false }; }
    function load() {
        if (M) return Promise.resolve(M);
        if (loading) return loading;
        loading = TV.idb.get(MKEY).then(function (m) {
            loading = null;
            if (M) return M;                     // linked again meanwhile: the new account's
            M = m && m.v === 1 ? m : empty();
            M.play = M.play || [];
            reindex();
            if (Object.keys(M.items).length) D.resumeChanged();
            return M;
        }, function () { loading = null; if (!M) { M = empty(); reindex(); } return M; });
        return loading;
    }
    var saveSoon = TV.debounce(function () { if (M) TV.idb.set(MKEY, M); }, 1500);
    function tkey(s) { return D.titleKey ? D.titleKey(s) : String(s || "").toLowerCase(); }
    function reindex() {
        IX = { m: { tm: {}, im: {}, t: {} }, s: { tm: {}, im: {}, t: {} } };
        if (M) Object.keys(M.items).forEach(function (k) {
            var x = M.items[k], g = IX[k.charAt(0)];
            if (!g || !x) return;
            if (x.tm) g.tm[x.tm] = k;
            if (x.im) g.im[x.im] = k;
            var tk = tkey(x.t);
            if (tk.length > 1) (g.t[tk] = g.t[tk] || []).push(k);
        });
        ver++;
    }
    function changed() { reindex(); saveSoon(); D.resumeChanged(); }
    /* A row of /sync/all-items, as APL TV keeps it */
    function fromRow(row, type) {
        var o = (row && (row.movie || row.show || row.anime)) || {}, ids = o.ids || {};
        if (!ids.simkl) return null;
        var x = { t: o.title || "", y: o.year || 0, tm: ids.tmdb ? String(ids.tmdb) : "", im: ids.imdb || "", tv: ids.tvdb ? String(ids.tvdb) : "",
                  st: row.status || "", w: ms(row.last_watched_at), l: ms(row.added_to_watchlist_at), nx: row.next_to_watch || "" };
        if (type === "anime") x.a = 1;
        var eps = null;
        function ep(sn, e) {
            if (!e || e.watched === false) return;
            var s = e.tvdb && e.tvdb.season ? e.tvdb.season : sn, n = e.tvdb && e.tvdb.episode ? e.tvdb.episode : e.number;
            if (!n) return;
            eps = eps || {};
            eps[s + ":" + n] = ms(e.watched_at) || x.w || 1;
        }
        (row.seasons || []).forEach(function (s) { (s.episodes || []).forEach(function (e) { ep(s.number || 1, e); }); });
        (row.episodes || []).forEach(function (e) { ep(1, e); });          // anime numbered from 1 to the end, no seasons
        if (eps) x.eps = eps;
        return { k: (type === "movies" ? "m" : "s") + ids.simkl, x: x };
    }
    function rowsOf(j, type) { var l = j && (Array.isArray(j) ? j : j[type]); return Array.isArray(l) ? l : []; }
    function merge(j, into) {
        var n = 0;
        ["movies", "shows", "anime"].forEach(function (type) {
            rowsOf(j, type).forEach(function (row) { var r = fromRow(row, type); if (r) { into[r.k] = r.x; n++; } });
        });
        return n;
    }
    function fromPlay(r) {
        var o = r.movie || r.show || r.anime || {}, ids = o.ids || {}, e = r.episode || {};
        var g = r.type === "movie" ? "m" : "s";
        if (!r.id || (!ids.simkl && !ids.tmdb && !ids.imdb && !o.title)) return null;
        var p = { id: r.id, p: Math.max(0, Math.min(100, +r.progress || 0)), at: ms(r.paused_at), g: g, k: ids.simkl ? g + ids.simkl : "",
                  tm: ids.tmdb ? String(ids.tmdb) : "", im: ids.imdb || "", t: o.title || "", y: o.year || 0 };
        if (g === "s") { p.se = +(e.tvdb_season || e.season) || 1; p.en = +(e.tvdb_number || e.number) || 0; if (!p.en) return null; }
        return p;
    }

    /* ---------- a title of your catalog, on Simkl ---------- */
    function hasTmdb() { return !!(TV.meta && TV.meta.enabled && TV.meta.enabled()); }
    /* The key of its entry in your Simkl library, or "": by TMDB or IMDb id, else by title and year */
    function keyOf(item) {
        if (!M || !item || !IX) return "";
        if (item._skv === ver) return item._sk;
        var g = item.kind === "series" ? "s" : "m", ix = IX[g], k = "";
        var m = TV.meta && TV.meta.known ? TV.meta.known(item) : null;
        var tm = String(item.tmdb || (m && m.tmdbId) || (item._ref && item._ref.id) || "");
        if (tm && ix.tm[tm]) k = ix.tm[tm];
        if (!k && m && m.imdbId && ix.im[m.imdbId]) k = ix.im[m.imdbId];
        if (!k) {
            var t = S.title(item.name || item.title), y = t.year || item.year || (m && m.year) || 0, seen = {}, ok = [];
            [t.title, item.title, m && m.title, m && m.original].forEach(function (name) {
                var tk = tkey(name);
                (tk.length > 1 && ix.t[tk] || []).forEach(function (c) {
                    var x = M.items[c];
                    if (seen[c] || !x) return;
                    seen[c] = 1;
                    if (y && x.y && Math.abs(x.y - y) > 1) return;
                    if (tm && x.tm && x.tm !== tm) return;          // another title of the same name
                    ok.push(c);
                });
            });
            // with a year, the closest; without one, only when there is no doubt
            if (ok.length === 1 || (y && ok.length)) k = ok.sort(function (a, b) { return Math.abs((M.items[a].y || y) - y) - Math.abs((M.items[b].y || y) - y); })[0];
        }
        // not found while TMDB may still tell its id: asked again next time
        if (k || m || !hasTmdb()) { item._sk = k; item._skv = ver; }
        return k;
    }
    function watchedOf(x, se, en) {
        if (!x) return 0;
        if (se === undefined) return x.st === "completed" ? (x.w || 1) : 0;
        if (x.eps && x.eps[se + ":" + en]) return x.eps[se + ":" + en];
        return x.st === "completed" ? (x.w || 1) : 0;           // a series finished on Simkl: all its episodes
    }
    /* When Simkl says you watched this movie, or this episode (ms), or 0 (js/data.js watched) */
    function watchedAt(item, ep) {
        if (!M || !wants("Watched") || !item) return 0;
        var k = keyOf(item), x = k && M.items[k];
        if (!x) return 0;
        if (!ep) return item.kind === "series" ? 0 : watchedOf(x);
        var en = +ep.episode || 0;
        return en ? watchedOf(x, +ep.season || 1, en) : 0;
    }
    function idsOf(x, k) {
        var ids = {};
        if (k) ids.simkl = +k.slice(1);
        if (x && x.tm) ids.tmdb = x.tm;
        if (x && x.im) ids.imdb = x.im;
        if (x && x.tv) ids.tvdb = x.tv;
        return ids;
    }
    /* What Simkl needs to know which title it is: its ids (Simkl's own when known), its title and year */
    function refOf(item) {
        if (!item) return Promise.resolve(null);
        return load().then(function () {
            var g = item.kind === "series" ? "s" : "m", k = keyOf(item), x = k && M.items[k];
            if (x) return { g: g, k: k, ids: idsOf(x, k), title: x.t, year: x.y };
            var known = TV.meta && TV.meta.known ? TV.meta.known(item) : null;
            var p = known || item.tmdb || !hasTmdb() ? Promise.resolve(known) : TV.meta.lookup(item, item._ref && item._ref.id);
            return p.then(function (m) {
                var ids = {}, t = S.title(item.name || item.title), tm = item.tmdb || (m && m.tmdbId) || (item._ref && item._ref.id);
                if (tm) ids.tmdb = String(tm);
                if (m && m.imdbId) ids.imdb = m.imdbId;
                // Simkl's titles are in English: TMDB's original title when written in Latin letters, else yours
                var name = m && m.original && /^[\u0000-ɏ\s]+$/.test(m.original) ? m.original : (m && m.title) || t.title || item.title || item.name;
                var ref = { g: g, k: "", ids: ids, title: name || "", year: (m && m.year) || t.year || item.year || 0 };
                if (ids.tmdb && IX[g].tm[ids.tmdb]) { ref.k = IX[g].tm[ids.tmdb]; ref.ids.simkl = +ref.k.slice(1); }
                return ref.title || ids.tmdb || ids.imdb ? ref : null;
            });
        });
    }
    function body(ref) { var o = { ids: ref.ids }; if (ref.title) o.title = ref.title; if (ref.year) o.year = ref.year; return o; }

    /* ---------- changes made here: a queue, kept until Simkl took them ---------- */
    function queue() { return TV.load("simklOut", []) || []; }
    function sig(op) { return op.ref.g + JSON.stringify(op.ref.ids) + op.ref.title + "|" + (op.eps || []).map(function (e) { return e[0] + "x" + e[1]; }).join(","); }
    var OPPOSITE = { hist: "unhist", unhist: "hist", list: "unlist", unlist: "list" };
    function enqueue(op) {
        var q = queue(), s = sig(op);
        op.n = TV.uid();
        // the opposite still waiting (marked, then unmarked before anything went out): both go
        for (var i = q.length - 1; i >= 0; i--) if (q[i].op === OPPOSITE[op.op] && q[i].ref && sig(q[i]) === s) { q.splice(i, 1); TV.save("simklOut", q); return; }
        q.push(op);
        if (q.length > 500) q = q.slice(q.length - 500);
        TV.save("simklOut", q);
        flushSoon();
    }
    var ENDPOINT = { hist: "/sync/history", unhist: "/sync/history/remove", unlist: "/sync/history/remove", list: "/sync/add-to-list" };
    /* One request for a group of changes of the same kind: movies and series, each series with its episodes */
    function bodyOf(ops) {
        var out = { movies: [], shows: [] }, shows = {};
        ops.forEach(function (op) {
            var o = body(op.ref);
            if (op.op === "list") o.to = "plantowatch";
            if (op.ref.g === "m") {
                if (op.op === "hist") o.watched_at = iso(op.at);
                out.movies.push(o);
                return;
            }
            var key = JSON.stringify(op.ref.ids) + op.ref.title, sh = shows[key];
            if (!sh) { sh = shows[key] = o; out.shows.push(o); }
            if (!op.eps) return;
            sh.seasons = sh.seasons || [];
            op.eps.forEach(function (e) {
                var season = null;
                sh.seasons.forEach(function (s) { if (s.number === e[0]) season = s; });
                if (!season) { season = { number: e[0], episodes: [] }; sh.seasons.push(season); }
                var one = { number: e[1] };
                if (op.op === "hist") one.watched_at = iso(e[2] || op.at);
                season.episodes.push(one);
            });
        });
        if (!out.movies.length) delete out.movies;
        if (!out.shows.length) delete out.shows;
        return out;
    }
    var flushing = null, flushTimer = null, retryAt = 0;
    function flushSoon() { clearTimeout(flushTimer); flushTimer = setTimeout(function () { flush().catch(noop); }, 4000); }
    function flush() {
        if (flushing) return flushing;
        if (!linked() || Date.now() < retryAt) return Promise.resolve();
        var q = queue().slice(0, 100);
        if (!q.length) return Promise.resolve();
        var groups = [];
        q.forEach(function (op) {
            var last = groups[groups.length - 1], ep = op.op === "unplay" ? "unplay" : ENDPOINT[op.op];
            if (!ep) return;
            if (last && last.ep === ep && ep !== "unplay") last.ops.push(op); else groups.push({ ep: ep, ops: [op] });
        });
        var done = {}, stop = false;
        function forget(ops) { ops.forEach(function (o) { done[o.n] = 1; }); TV.save("simklOut", queue().filter(function (o) { return !done[o.n]; })); }
        flushing = sequence(groups, function (gr) {
            if (stop) return null;
            var p = gr.ep === "unplay" ? write("DELETE", "/sync/playback/" + encodeURIComponent(gr.ops[0].id)) : write("POST", gr.ep, bodyOf(gr.ops));
            return p.then(function (r) {
                var nf = r && r.not_found, miss = nf ? (nf.movies || []).length + (nf.shows || []).length + (nf.episodes || []).length : 0;
                TV.log("simkl: " + gr.ops.length + " change(s) sent (" + gr.ep + ")" + (miss ? ", " + miss + " not found on Simkl" : ""));
                forget(gr.ops);
            }, function (e) {
                if (gr.ep === "unplay" && e.status === 404) { forget(gr.ops); return; }
                if (retryable(e)) { stop = true; retryAt = Date.now() + 2 * 60000; TV.log("simkl: changes kept for later (" + e.message + ")"); return; }
                TV.log("simkl: changes refused (" + e.message + ")");
                forget(gr.ops);
            });
        }).then(function () {
            flushing = null;
            if (!stop && queue().length) flushSoon();
        }, function (e) { flushing = null; throw e; });
        return flushing;
    }

    /* ---------- from APL TV to Simkl ---------- */
    /* Marked by hand (js/data.js markWatched): a movie, or episodes */
    function markWatched(item, eps, on) {
        if (!wants("Watched") || !item) return;
        var list = eps && eps.length ? eps.filter(function (e) { return e && +e.episode; }) : null;
        if (item.kind === "series" && !(list && list.length)) return;
        refOf(item).then(function (ref) {
            if (!ref) return;
            var at = Date.now(), x = ref.k && M.items[ref.k];
            if (!list) {
                // nothing to change there: already watched, or never was
                if (on && x && x.st === "completed") return;
                if (!on && M.snap && !watchedOf(x)) return;
                enqueue({ op: on ? "hist" : "unhist", ref: ref, at: at });
                if (x) { if (on) { x.st = "completed"; x.w = at; } else { x.st = ""; x.w = 0; } changed(); }
                return;
            }
            var todo = list.filter(function (e) { var w = watchedOf(x, +e.season || 1, +e.episode); return on ? !w : (!M.snap || !!w); });
            if (!todo.length) return;
            enqueue({ op: on ? "hist" : "unhist", ref: ref, at: at, eps: todo.map(function (e) { return [+e.season || 1, +e.episode, at]; }) });
            if (x) {
                if (!on && x.st === "completed") x.st = "watching";
                x.eps = x.eps || {};
                todo.forEach(function (e) { var kk = (+e.season || 1) + ":" + (+e.episode); if (on) x.eps[kk] = at; else delete x.eps[kk]; });
                changed();
            }
        }).catch(function (e) { TV.log("simkl mark: " + e.message); });
    }
    /* My List (js/data.js toggleMyList): your Plan to Watch list. A title you watch or watched there keeps its place
       on Simkl; one taken out is taken out of Simkl only while it waits in Plan to Watch (taking it out there deletes
       its whole entry) */
    function listChanged(item, on) {
        if (!wants("List") || !item) return;
        refOf(item).then(function (ref) {
            if (!ref) return;
            var x = ref.k && M.items[ref.k], base = listBase();
            if (on) {
                if (x && x.st) { if (x.st === "plantowatch") { base.map[ref.k] = item.id; TV.save("simklList", base); } return; }
                enqueue({ op: "list", ref: ref, at: Date.now() });
                return;
            }
            if (!x || x.st !== "plantowatch") return;
            enqueue({ op: "unlist", ref: ref, at: Date.now() });
            x.st = "";
            delete base.base[ref.k]; delete base.map[ref.k];
            TV.save("simklList", base);
            changed();
        }).catch(function (e) { TV.log("simkl list: " + e.message); });
    }
    /* Out of Continue Watching (js/data.js forget): its paused place on Simkl goes too */
    function forgot(item) {
        if (!M || !item || !wants("Resume")) return;
        var k = keyOf(item), g = item.kind === "series" ? "s" : "m", left = [];
        M.play.forEach(function (p) {
            if (p.g === g && ((k && p.k === k) || p.cat === item.id)) enqueue({ op: "unplay", id: p.id, ref: { g: g, ids: {}, title: "" }, at: Date.now() });
            else left.push(p);
        });
        if (left.length !== M.play.length) { M.play = left; saveSoon(); }
    }
    /* The player (js/osd.js tell): started, and stopped (finished or not) */
    function scrobble(event, o, pos, dur, done) {
        if (!o || !o.item || o.noResume || (event !== "start" && event !== "stop")) return;
        if (!(wants("Resume") || (done && wants("Watched")))) return;
        var pct = dur ? Math.min(100, Math.round(1000 * pos / dur) / 10) : 0, ep = o.ep, at = Date.now();
        if (ep && !+ep.episode) return;
        refOf(o.item).then(function (ref) {
            if (!ref) return null;
            var b = { progress: pct };
            if (ep) { b.show = body(ref); b.episode = { season: +ep.season || 1, number: +ep.episode }; } else b.movie = body(ref);
            if (event === "start") return wants("Resume") && pct < 95 ? write("POST", "/scrobble/start", b) : null;
            if (done) {
                if (!wants("Watched")) return null;
                b.progress = Math.max(pct, 90);                  // finished for APL TV: watched for Simkl too (from 80 %)
                var x = ref.k && M.items[ref.k];
                if (x) { if (ep) { x.eps = x.eps || {}; x.eps[b.episode.season + ":" + b.episode.number] = at; } else { x.st = "completed"; x.w = at; } changed(); }
                return write("POST", "/scrobble/stop", b).catch(function (e) {
                    if (retryable(e)) enqueue({ op: "hist", ref: ref, at: at, eps: ep ? [[b.episode.season, b.episode.number, at]] : null });
                    throw e;
                });
            }
            if (!wants("Resume") || pos < 60 || pct < 1) return null;
            return write("POST", "/scrobble/pause", b);
        }).catch(function (e) { TV.log("simkl " + event + ": " + e.message); });
    }

    /* ---------- from Simkl to APL TV ---------- */
    var syncing = null, lastCheck = 0, failUntil = 0, lastError = "";
    /* Checked (and pulled when something moved): at most every 15 minutes unless asked (Settings, linking) */
    function sync(force) {
        if (!linked()) return Promise.resolve(false);
        if (syncing) return syncing;
        if (!force && (Date.now() - lastCheck < POLL_MS || Date.now() < failUntil)) return Promise.resolve(false);
        lastCheck = Date.now();
        if (force) retryAt = 0;
        syncing = load().then(function () { return flush().catch(noop); }).then(pull).then(function (got) {
            syncing = null; lastError = "";
            if (got) changed();
            return inbound().then(function () { return got; });
        }, function (e) {
            syncing = null; failUntil = Date.now() + FAIL_MS; lastError = e.message;
            TV.log("simkl sync: " + e.message);
            return false;
        });
        return syncing;
    }
    function moved(acts, old, sec, keys) {
        var a = (acts && acts[sec]) || {}, o = (old && old[sec]) || {};
        return keys.some(function (k) { return (a[k] || "") !== (o[k] || ""); });
    }
    var LISTS = ["watching", "plantowatch", "hold", "completed", "dropped"];
    function pull() {
        var mine = M;
        return api("GET", "/sync/activities").then(function (acts) {
            if (!acts) throw new Error("no activities");
            var old = M.snap, full = !old || Date.now() - (M.full || 0) > FULL_MS;
            if (!full && old.all && old.all === acts.all) { M.at = Date.now(); saveSoon(); return false; }      // nothing moved anywhere
            var items = full ? {} : null, play = null, keep = null, t0 = Date.now();
            var jobs = [];
            if (full) {
                // the whole library, one kind after the other (Simkl: not at the same time)
                ["shows", "movies", "anime"].forEach(function (type) {
                    jobs.push(function () { return api("GET", "/sync/all-items/" + type, { extended: "full", episode_watched_at: "yes" }).then(function (j) { merge(j, items); }); });
                });
            } else {
                var lists = ["tv_shows", "anime", "movies"].some(function (s) { return moved(acts, old, s, LISTS); });
                if (lists) jobs.push(function () {
                    return api("GET", "/sync/all-items", { date_from: old.all, extended: "full", episode_watched_at: "yes" }).then(function (j) { items = {}; merge(j, items); });
                });
                if (["tv_shows", "anime", "movies"].some(function (s) { return moved(acts, old, s, ["removed_from_list"]); })) jobs.push(function () {
                    return api("GET", "/sync/all-items", { extended: "simkl_ids_only" }).then(function (j) {
                        keep = {};
                        ["movies", "shows", "anime"].forEach(function (type) {
                            rowsOf(j, type).forEach(function (row) { var o = row.movie || row.show || row.anime || {}; if (o.ids && o.ids.simkl) keep[(type === "movies" ? "m" : "s") + o.ids.simkl] = 1; });
                        });
                    });
                });
            }
            if (full || ["tv_shows", "anime", "movies"].some(function (s) { return moved(acts, old, s, ["playback"]); })) jobs.push(function () {
                return api("GET", "/sync/playback").then(function (j) { play = (Array.isArray(j) ? j : []).map(fromPlay).filter(Boolean); });
            });
            return sequence(jobs, function (job) { return job(); }).then(function () {
                if (M !== mine) throw new Error("linked again meanwhile");
                // every request answered: only now is the new snapshot kept (Simkl's rule)
                var n = 0;
                if (full) { M.items = items; M.full = Date.now(); n = Object.keys(items).length; }
                else {
                    if (keep) Object.keys(M.items).forEach(function (k) { if (!keep[k]) { delete M.items[k]; n++; } });
                    if (items) Object.keys(items).forEach(function (k) { M.items[k] = items[k]; n++; });
                }
                if (play) M.play = play.map(function (p) { var was = M.play.filter(function (q) { return q.id === p.id; })[0]; if (was && was.cat) p.cat = was.cat; return p; });
                M.snap = acts; M.at = Date.now();
                TV.log("simkl: " + (full ? "library pulled, " + n + " titles" : n + " title(s) changed") + (play ? ", " + play.length + " paused" : "") + " in " + (Date.now() - t0) + " ms");
                return true;
            });
        });
    }

    /* A Simkl title in your catalog: by the TMDB id your sources give (media servers, Stremio), by its title and year,
       or by TMDB's titles in your language. The version you prefer (js/data.js pickVersion). */
    var found = {}, foundFor = null, tmIndex = null;
    function tmdbIndex(kind) {
        var cat = D.catalog();
        if (!tmIndex) {
            tmIndex = { movies: {}, series: {} };
            ["movies", "series"].forEach(function (k) { (cat ? cat[k].items : []).forEach(function (x) { if (x.tmdb) (tmIndex[k][String(x.tmdb)] = tmIndex[k][String(x.tmdb)] || []).push(x); }); });
        }
        return tmIndex[kind];
    }
    function byTitle(kind, titles, y) {
        return D.titleIndex(kind).then(function (idx) {
            var out = [], seen = {};
            titles.forEach(function (t) {
                var k = tkey(t);
                if (k.length < 2) return;
                (idx[k] || []).forEach(function (x) {
                    if (seen[x.id] || (y && x.year && Math.abs(x.year - y) > 1)) return;
                    seen[x.id] = 1; out.push(x);
                });
            });
            return out;
        });
    }
    function find(g, ref) {
        var cat = D.catalog(), kind = g === "m" ? "movies" : "series";
        if (!cat) return Promise.resolve(null);
        if (foundFor !== cat) { found = {}; tmIndex = null; foundFor = cat; }
        var ck = g + (ref.tm ? "t" + ref.tm : tkey(ref.t) + ":" + (ref.y || ""));
        if (Object.prototype.hasOwnProperty.call(found, ck)) return Promise.resolve(found[ck] ? D.itemById(found[ck]) : null);
        var hits = ref.tm ? (tmdbIndex(kind)[ref.tm] || []) : [];
        return (hits.length ? Promise.resolve(hits) : byTitle(kind, [ref.t], ref.y)).then(function (h) {
            if (h.length || !ref.tm || !hasTmdb()) return h;
            return TV.meta.lookup({ kind: g === "m" ? "movie" : "series", name: ref.t, title: ref.t, year: ref.y }, +ref.tm).then(function (m) {
                return m ? byTitle(kind, [m.title, m.original], m.year || ref.y) : [];
            });
        }).then(function (h) {
            h = h.filter(function (x) { return !D.isHidden(x); });
            var it = D.pickVersion(h);
            found[ck] = it ? it.id : "";
            return it;
        }, function () { return null; });
    }
    function refFrom(x) { return { tm: x.tm, im: x.im, t: x.t, y: x.y }; }
    /* Its length: what APL TV or TMDB knows, else a guess, made exact once the video starts (js/osd.js) */
    function lengthOf(item, ep, known) {
        if (known && known.dur > 60) return { dur: known.dur, est: false };
        if (!ep && (item.dur || item._dur)) return { dur: item.dur || item._dur, est: false };
        var m = TV.meta && TV.meta.known ? TV.meta.known(item) : null;
        if (m && m.runtime) return { dur: m.runtime * 60, est: true };
        return { dur: ep ? 45 * 60 : 100 * 60, est: true };
    }
    function labelOf(se, en) { return T("S{s} E{e}", { s: se, e: en }); }
    function parseEp(s) { var m = String(s || "").match(/S(\d+)E(\d+)/i) || String(s || "").match(/^E(\d+)$/i); if (!m) return null; return m[2] ? { se: +m[1], en: +m[2] } : { se: 1, en: +m[1] }; }

    var inbounding = null;
    function inbound() {
        if (!M || !linked() || !D.catalog()) return Promise.resolve();
        if (inbounding) return inbounding;
        var p = Promise.resolve();
        if (wants("List")) p = p.then(applyList);
        if (wants("Resume")) p = p.then(applyResume);
        if (wants("Watched")) p = p.then(reconcile);
        if (!M.seeded && M.snap) p = p.then(seed);
        inbounding = p.then(function () { inbounding = null; }, function (e) { inbounding = null; TV.log("simkl: " + e.message); });
        return inbounding;
    }
    /* My List: what was added to or taken out of Plan to Watch since last time (titles APL TV finds) */
    function listBase() { var b = TV.load("simklList", null); return b && b.base ? b : { base: {}, map: {} }; }
    function applyList() {
        var b = listBase(), now = {}, add = [], remove = [], keys = [];
        Object.keys(M.items).forEach(function (k) { if (M.items[k].st === "plantowatch") now[k] = 1; });
        Object.keys(b.base).forEach(function (k) { if (!now[k] && b.map[k]) { remove.push(b.map[k]); delete b.map[k]; } });
        Object.keys(now).forEach(function (k) { if (!b.base[k] || !b.map[k]) keys.push(k); });
        keys = keys.sort(function (a, c) { return (M.items[c].l || 0) - (M.items[a].l || 0); }).slice(0, 300);
        return sequence(keys, function (k) {
            var x = M.items[k];
            return find(k.charAt(0), refFrom(x)).then(function (it) {
                if (!it) return;
                b.map[k] = it.id;
                if (!b.base[k]) add.push(it.id);         // new on Simkl since last time (an old one taken out here stays out)
            });
        }).then(function () {
            b.base = now;
            TV.save("simklList", b);
            if (D.setMyList(add, remove)) TV.log("simkl: My List " + (add.length ? "+" + add.length : "") + (remove.length ? " -" + remove.length : ""));
        });
    }
    /* Continue Watching: paused in another app, the next episode of what you watch, the movies watched lately */
    function applyResume() {
        var list = [], now = Date.now();
        // Up Next first, so a paused episode of the same series (later) replaces it
        var upnext = Object.keys(M.items).filter(function (k) { var x = M.items[k]; return k.charAt(0) === "s" && x.st === "watching" && x.nx && x.w && now - x.w < UPNEXT_MS; })
            .sort(function (a, b) { return M.items[b].w - M.items[a].w; }).slice(0, 25);
        var recent = Object.keys(M.items).filter(function (k) { var x = M.items[k]; return k.charAt(0) === "m" && x.st === "completed" && x.w && now - x.w < RECENT_MS; })
            .sort(function (a, b) { return M.items[b].w - M.items[a].w; }).slice(0, 30);
        var plays = M.play.slice().sort(function (a, b) { return a.at - b.at; }).slice(-30);
        // started here or paused in another app, then finished in another app: ticked, out of Continue Watching; a
        // place paused in another app that Simkl has no more (taken out there, or watched since): out of it too
        var r = D.resumes(), drop = [], open = {};
        M.play.forEach(function (p) { open["p" + p.id] = 1; });
        Object.keys(r).forEach(function (key) {
            var e = r[key], it = e && !e.done && !e.manual && e.item ? D.itemById(e.item) : null;
            if (!it) return;
            var k = keyOf(it), x = k && M.items[k], isEp = key !== e.item && !e.series, w;
            if (e.series) w = x && x.st === "completed" ? x.w : 0;
            else w = isEp ? (e.se && e.en ? watchedOf(x, e.se, e.en) : 0) : watchedOf(x);
            if (w > e.at + SLACK) {
                var d = { key: key, item: e.item, ep: e.ep || null, pos: e.dur || 1, dur: e.dur || 1, done: true, at: w, simkl: true };
                if (e.se) { d.se = e.se; d.en = e.en; }
                if (e.series) { d.series = true; d.epLabel = e.epLabel; } else d.sk = isEp ? k + "|" + e.se + ":" + e.en : k;
                list.push(d);
            } else if (typeof e.sk === "string" && e.sk.charAt(0) === "p" && !open[e.sk]) drop.push(key);
        });
        if (drop.length) D.simklResumes(drop, {});
        return sequence(upnext, function (k) {
            var x = M.items[k], n = parseEp(x.nx);
            if (!n) return null;
            return find("s", refFrom(x)).then(function (it) {
                if (!it) return;
                var mine = D.resumeOf(it.id);
                if (mine && mine.at >= x.w - SLACK) return;
                list.push({ key: it.id, item: it.id, ep: null, se: n.se, en: n.en, pos: 0, dur: 0, epLabel: labelOf(n.se, n.en), series: true, upNext: true, at: x.w, simkl: true });
            });
        }).then(function () {
            return sequence(recent, function (k) {
                var x = M.items[k];
                return find("m", refFrom(x)).then(function (it) {
                    if (!it || D.resumeOf(it.id)) return;
                    list.push({ key: it.id, item: it.id, pos: 1, dur: 1, done: true, at: x.w, simkl: true, sk: k });
                });
            });
        }).then(function () {
            return sequence(plays, function (p) {
                if (p.p < 1 || p.p >= 95) return null;
                var x = p.k && M.items[p.k], ref = x ? refFrom(x) : { tm: p.tm, im: p.im, t: p.t, y: p.y };
                return find(p.g, ref).then(function (it) {
                    if (!it) return;
                    p.cat = it.id;
                    var key = it.id, mine = D.resumeOf(key);
                    if (mine && mine.at >= p.at - SLACK) return;
                    if (p.g === "m") {
                        if (mine && mine.dur && !mine.done && Math.abs(100 * mine.pos / mine.dur - p.p) < 3) return;   // the same place
                        var l = lengthOf(it, null, mine);
                        list.push({ key: key, item: it.id, pos: Math.round(l.dur * p.p / 100), dur: l.dur, pct: p.p, est: l.est, at: p.at, simkl: true, sk: "p" + p.id });
                        return;
                    }
                    if (mine && +mine.se === p.se && +mine.en === p.en && mine.dur && Math.abs(100 * mine.pos / mine.dur - p.p) < 3) return;
                    var le = lengthOf(it, true, null);
                    list.push({ key: key, item: it.id, ep: null, se: p.se, en: p.en, pos: Math.round(le.dur * p.p / 100), dur: le.dur, pct: p.p, est: true,
                                epLabel: labelOf(p.se, p.en), series: true, at: p.at, simkl: true, sk: "p" + p.id });
                });
            });
        }).then(function () {
            saveSoon();
            if (list.length && D.syncResumes(list)) TV.log("simkl: Continue Watching, " + list.length + " title(s) from Simkl");
        });
    }
    /* Watched here and known to Simkl: marked unwatched there since, unwatched here too */
    function reconcile() {
        var r = D.resumes(), drop = [], known = {};
        Object.keys(r).forEach(function (key) {
            var e = r[key];
            if (!e || !e.done || !e.item || e.series) return;
            // known to Simkl (by its key there, even when Simkl has the title no more): still watched there?
            if (typeof e.sk === "string") {
                var part = e.sk.split("|"), n = part[1] ? part[1].split(":") : null;
                if (!(n ? watchedOf(M.items[part[0]], +n[0], +n[1]) : watchedOf(M.items[part[0]])) && M.at > e.at + SLACK) drop.push(key);
                return;
            }
            // not yet: is it there now?
            var it = D.itemById(e.item);
            if (!it) return;
            var k = keyOf(it), x = k && M.items[k], isEp = key !== e.item;
            if (!x || (isEp && !(e.se && e.en))) return;
            if (isEp ? watchedOf(x, e.se, e.en) : watchedOf(x)) known[key] = isEp ? k + "|" + e.se + ":" + e.en : k;
        });
        if (D.simklResumes(drop, known) && drop.length) TV.log("simkl: " + drop.length + " marked unwatched on Simkl");
    }
    /* The first time: what you watched in APL TV and your My List go to Simkl (what it does not have yet) */
    function seed() {
        var r = D.resumes(), jobs = [];
        Object.keys(r).forEach(function (key) {
            var e = r[key];
            if (!e || !e.done || !e.item || e.series) return;
            var it = D.itemById(e.item);
            if (!it) return;
            if (key === e.item && it.kind === "movie") jobs.push({ it: it, at: e.at });
            else if (key !== e.item && e.se && e.en) jobs.push({ it: it, at: e.at, ep: [e.se, e.en, e.at] });
        });
        jobs = jobs.sort(function (a, b) { return b.at - a.at; }).slice(0, 300);
        var mine = wants("List") ? D.myList().map(D.itemById).filter(Boolean).slice(0, 200) : [];
        var sent = 0;
        return sequence(wants("Watched") ? jobs : [], function (j) {
            return refOf(j.it).then(function (ref) {
                if (!ref) return;
                var x = ref.k && M.items[ref.k];
                if (j.ep ? watchedOf(x, j.ep[0], j.ep[1]) : watchedOf(x)) return;
                enqueue({ op: "hist", ref: ref, at: j.at, eps: j.ep ? [j.ep] : null });
                sent++;
            }, noop);
        }).then(function () {
            return sequence(mine, function (it) { return refOf(it).then(function (ref) { if (ref && !(ref.k && M.items[ref.k] && M.items[ref.k].st)) { enqueue({ op: "list", ref: ref, at: Date.now() }); sent++; } }, noop); });
        }).then(function () {
            M.seeded = true; saveSoon();
            if (sent) TV.log("simkl: " + sent + " title(s) of APL TV sent to Simkl the first time");
        });
    }

    /* ---------- when ---------- */
    // start-up: your Simkl ticks before anything is drawn, then a check once the catalog is there
    if (account()) load();
    var started = false;
    var inboundSoon = TV.debounce(function () { inbound(); }, 3000);
    D.onChange(function (what) {
        if (what !== "catalog" || !linked()) return;
        tmIndex = null;
        if (!started) { started = true; setTimeout(function () { sync(); }, 8000); return; }
        inboundSoon();                  // a playlist refreshed or added: its titles may be the ones Simkl has
    });
    // back to the front (the TV woke up, APL TV opened again): a check, if the last one is 15 minutes old
    document.addEventListener("visibilitychange", function () { if (!document.hidden && started) sync(); });

    TV.simkl = {
        clientId: clientId, setClientId: function (v) { TV.save("simklClientId", String(v || "").replace(/\s+/g, "")); },
        builtIn: function () { return !!(CLIENT_ID || (global.TV_KEYS && global.TV_KEYS.simkl)); },
        account: account, linked: linked, pin: pin, check: check, unlink: unlink,
        sync: sync, fresh: function () { return sync(false); }, flush: flush,
        state: function () { return { at: M ? M.at : 0, titles: M ? Object.keys(M.items).length : 0, waiting: queue().length, busy: !!syncing, error: lastError }; },
        watchedAt: watchedAt, markWatched: markWatched, listChanged: listChanged, forgot: forgot, scrobble: scrobble
    };
})(window);
