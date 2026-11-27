// End-to-end test of APL TV's Simkl sync in the PC preview, against mock-simkl.js (see README.md; run.sh starts it all).
"use strict";
const { chromium } = require("playwright");
const path = require("path");
// screenshots and the app's log: a folder outside the repository
const OUT = process.env.OUT || path.join(require("os").tmpdir(), "apltv-simkl-e2e");
require("fs").mkdirSync(OUT, { recursive: true });
const MOCK = "http://127.0.0.1:8090";
const APP = "http://127.0.0.1:8080/index.html";

let failures = 0;
function check(name, ok, extra) { console.log((ok ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); if (!ok) failures++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mlog() { return (await fetch(MOCK + "/__log")).json(); }
async function mdo(what) { return (await fetch(MOCK + "/__do?what=" + what)).json(); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const logs = [];
  page.on("console", (m) => { const t = m.text(); if (/\[APL TV\]/.test(t)) logs.push(t); });
  page.on("pageerror", (e) => { logs.push("PAGEERROR " + e.message); });
  await page.addInitScript(() => {
    if (localStorage.getItem("apltv.sources")) return;
    localStorage.setItem("apltv.sources", JSON.stringify([{ id: "s1", type: "m3u", name: "Test", url: "http://127.0.0.1:8090/playlist.m3u" }]));
    localStorage.setItem("apltv.prefs", JSON.stringify({ setupDone: 1, language: "en", resumePrompt: false, sportsTab: false, tvGuide: false, crashReports: "never", autoUpdate: false, sounds: false }));
    localStorage.setItem("apltv.simklTest", JSON.stringify("http://127.0.0.1:8090"));
    localStorage.setItem("apltv.simklClientId", JSON.stringify("test-client"));
  });
  await page.goto(APP);
  await page.waitForFunction(() => window.TV && TV.data && TV.data.catalog() && TV.data.catalog().movies.items.length > 0, null, { timeout: 30000 });

  // helpers in the page
  await page.evaluate(() => {
    window.$m = (t, y) => TV.data.catalog().movies.items.filter((x) => x.title === t && (!y || x.year === y))[0];
    window.$s = (t) => TV.data.catalog().series.items.filter((x) => x.title === t)[0];
    window.$ep = (show, s, e) => { var sh = $s(show); var x = sh.eps.filter((q) => q.season === s && q.episode === e)[0]; return { id: x.id, season: s, episode: e }; };
    window.$w = (t, y) => TV.data.watched($m(t, y));
    window.$we = (show, s, e) => TV.data.watched($s(show), $ep(show, s, e));
    window.$list = () => TV.data.myList().map((id) => { var it = TV.data.itemById(id); return it ? it.title + (it.year ? " " + it.year : "") : id; });
    window.$cw = () => TV.data.continueWatching().map((x) => ({ t: x.item.title, upNext: !!x.resume.upNext, se: x.resume.se, en: x.resume.en, pct: x.resume.pct, est: !!x.resume.est, pos: x.resume.pos, dur: x.resume.dur }));
    window.$rw = () => TV.data.recentlyWatched().map((x) => x.title + (x.year ? " " + x.year : ""));
  });
  const cat = await page.evaluate(() => ({ movies: TV.data.catalog().movies.items.length, series: TV.data.catalog().series.items.length }));
  check("catalog loaded", cat.movies === 7 && cat.series === 3, cat);

  // ---- before linking: APL TV's own history and My List ----
  await page.evaluate(() => { TV.data.markWatched($m("Dune", 1984), null, true); TV.data.toggleMyList($m("Parasite").id); TV.data.toggleMyList($s("The Office").id); });
  check("nothing sent before linking", (await mlog()).length === 0);

  // ---- link through Settings ----
  await page.evaluate(() => TV.setup.media("simkl"));
  await page.waitForFunction(() => /ABCD-1234/.test(document.body.innerText) && document.getElementById("boot").classList.contains("is-hidden"), null, { timeout: 15000 });
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, "1-link.png") });
  check("link page shows the code", true);
  await page.waitForFunction(() => TV.simkl.linked() && TV.simkl.state().at > 0, null, { timeout: 30000 });
  await page.waitForFunction(() => TV.data.myList().length >= 4 && TV.data.continueWatching().length >= 3, null, { timeout: 20000 }).catch(() => {});
  await sleep(6500);                          // the first-time upload (queued, sent after 4 s)
  const acct = await page.evaluate(() => TV.simkl.account());
  check("account linked with name", acct.user === "tester" && !!acct.rt, { user: acct.user });
  await page.screenshot({ path: path.join(OUT, "2-simkl-page.png") });

  let L = await mlog();
  check("every request names the app", L.every((e) => e.q.client_id === "test-client" && e.q["app-name"] === "apl-tv" && e.q["app-version"]));
  check("first pull is the whole library, one kind at a time", ["shows", "movies", "anime"].every((t) => L.some((e) => e.p === "/sync/all-items/" + t && e.q.extended === "full")));
  check("playback asked", L.some((e) => e.p === "/sync/playback"));

  // ---- Simkl -> APL TV ----
  const r1 = await page.evaluate(() => ({
    inception: $w("Inception"), dune21: $w("Dune", 2021), dune84: $w("Dune", 1984), parasite: $w("Parasite"),
    bb11: $we("Breaking Bad", 1, 1), bb13: $we("Breaking Bad", 1, 3), bb14: $we("Breaking Bad", 1, 4), office13: $we("The Office", 1, 3), dark11: $we("Dark", 1, 1), dark12: $we("Dark", 1, 2),
    list: $list(), cw: $cw(), rw: $rw()
  }));
  check("Simkl watched movies ticked", r1.inception && r1.dune21 && !r1.parasite, r1);
  check("the other Dune (1984) not taken for the 2021 one (only its own local mark)", r1.dune84 === true);
  check("episodes watched on Simkl ticked, next one not", r1.bb11 && r1.bb13 && !r1.bb14 && r1.dark11 && !r1.dark12);
  check("a series completed on Simkl: every episode ticked", r1.office13);
  check("My List has Plan to Watch titles found in the catalog", r1.list.indexOf("The Matrix 1999") >= 0 && r1.list.indexOf("Arrival 2016") >= 0, r1.list);
  check("My List keeps the local ones", r1.list.indexOf("Parasite 2019") >= 0 && r1.list.indexOf("The Office") >= 0, r1.list);
  check("a PTW title not in the catalog is left out", r1.list.indexOf("The Godfather 1972") < 0);
  const arrival = r1.cw.filter((x) => x.t === "Arrival")[0], dark = r1.cw.filter((x) => x.t === "Dark")[0], bb = r1.cw.filter((x) => x.t === "Breaking Bad")[0];
  check("Continue Watching: movie paused in another app", arrival && arrival.pct === 40 && arrival.est && Math.round(100 * arrival.pos / arrival.dur) === 40, arrival);
  check("Continue Watching: episode paused in another app (by numbers)", dark && dark.se === 1 && dark.en === 2 && dark.pct === 30, dark);
  check("Up Next from Simkl", bb && bb.upNext && bb.se === 1 && bb.en === 4, bb);
  check("Recently Watched has Simkl's recent movies", r1.rw.indexOf("Inception 2010") >= 0 && r1.rw.indexOf("Dune 2021") >= 0, r1.rw);

  // first-time upload
  const hist = L.filter((e) => e.p === "/sync/history"), adds = L.filter((e) => e.p === "/sync/add-to-list");
  check("first time: local watched movie sent to history", hist.some((e) => (e.body.movies || []).some((m) => m.title === "Dune" && m.year === 1984)), hist.map((e) => e.body));
  check("first time: local My List title sent to Plan to Watch", adds.some((e) => (e.body.movies || []).some((m) => m.title === "Parasite" && m.to === "plantowatch")), adds.map((e) => e.body));
  check("first time: a title already watched on Simkl not sent to the list", !adds.some((e) => (e.body.shows || []).some((s) => s.title === "The Office")));
  check("JSON writes", hist.every((e) => /application\/json/.test(e.ct)));

  // ---- detail page: Up Next by numbers ----
  await page.evaluate(() => TV.detail.open($s("Breaking Bad")));
  await sleep(1500);
  const btn = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#detail .detail__btns .btn"), (b) => b.textContent.trim()));
  check("series page offers the Up Next episode", btn.some((t) => /S1 E4/.test(t)), btn);
  await page.screenshot({ path: path.join(OUT, "3-detail.png") });
  await page.evaluate(() => { if (TV.detail.isOpen()) TV.detail.close(); });

  // ---- APL TV -> Simkl ----
  let before = (await mlog()).length;
  await page.evaluate(() => {
    TV.data.toggleMyList($m("The Matrix").id);                          // taken out of My List
    TV.data.markWatched($m("Inception"), null, false);                  // unwatched
    var bb = $s("Breaking Bad");
    TV.data.markWatched(bb, [$ep("Breaking Bad", 1, 4)], true);         // one more episode
    TV.data.forget($s("Dark"));                                         // out of Continue Watching
    TV.simkl.scrobble("stop", { item: $m("Arrival"), resumeKey: $m("Arrival").id }, 95, 100, true);
    TV.simkl.scrobble("stop", { item: $m("Parasite"), resumeKey: $m("Parasite").id }, 1500, 7200, false);
  });
  await sleep(9000);
  L = (await mlog()).slice(before);
  const after = await page.evaluate(() => ({ inception: $w("Inception"), bb14: $we("Breaking Bad", 1, 4), list: $list(), arrival: $w("Arrival"), cw: $cw().map((x) => x.t) }));
  check("My List removal -> history/remove of a Plan to Watch title", L.some((e) => e.p === "/sync/history/remove" && (e.body.movies || []).some((m) => m.ids && m.ids.simkl === 102)), L.map((e) => e.p));
  check("unwatched -> history/remove", L.some((e) => e.p === "/sync/history/remove" && (e.body.movies || []).some((m) => m.ids && m.ids.simkl === 101)));
  check("unwatched shows at once", after.inception === false);
  check("episode watched -> history with its numbers", L.some((e) => e.p === "/sync/history" && (e.body.shows || []).some((s) => s.ids.simkl === 201 && s.seasons[0].number === 1 && s.seasons[0].episodes[0].number === 4)));
  check("removed from Continue Watching -> its playback deleted", L.some((e) => e.m === "DELETE" && e.p === "/sync/playback/5002"));
  check("finished -> scrobble/stop at 90 % or more", L.some((e) => e.p === "/scrobble/stop" && e.body.progress >= 90 && e.body.movie && e.body.movie.ids.simkl === 105));
  check("stopped midway -> scrobble/pause", L.some((e) => e.p === "/scrobble/pause" && e.body.progress > 20 && e.body.progress < 21));
  const times = L.filter((e) => e.m !== "GET").map((e) => e.at);
  check("writes at least a second apart", times.every((t, i) => !i || t - times[i - 1] >= 1000), times.map((t, i) => i ? t - times[i - 1] : 0));
  check("Dark out of Continue Watching", after.cw.indexOf("Dark") < 0, after.cw);

  // ---- "watching now" only after a minute; a session started is always closed ----
  before = (await mlog()).length;
  await page.evaluate(() => {
    window.$o1 = { item: $m("Dune", 2021), resumeKey: $m("Dune", 2021).id };
    TV.simkl.scrobble("start", $o1, 0, 9000); TV.simkl.scrobble("progress", $o1, 20, 9000); TV.simkl.scrobble("stop", $o1, 30, 9000, false);
  });
  await sleep(2500);
  check("opened by mistake and left within a minute -> nothing sent", (await mlog()).length === before, (await mlog()).slice(before).map((e) => e.p));
  await page.evaluate(() => {
    window.$o2 = { item: $m("Parasite"), resumeKey: $m("Parasite").id };
    TV.simkl.scrobble("start", $o2, 600, 7200); TV.simkl.scrobble("progress", $o2, 630, 7200); TV.simkl.scrobble("progress", $o2, 665, 7200); TV.simkl.scrobble("progress", $o2, 675, 7200);
  });
  await sleep(2500);
  L = (await mlog()).slice(before);
  check("a minute of playback -> one scrobble/start", L.filter((e) => e.p === "/scrobble/start").length === 1, L.map((e) => e.p));
  // the pause fails once (Simkl busy): kept, sent with the next changes
  await mdo("fail-next-pause");
  before = (await mlog()).length;
  await page.evaluate(() => TV.simkl.scrobble("stop", $o2, 700, 7200, false));
  await sleep(2500);
  const queued = await page.evaluate(() => TV.simkl.state().waiting);
  check("failed pause kept in the queue", queued === 1, queued);
  await page.evaluate(() => TV.simkl.sync(true));
  await page.waitForFunction(() => !TV.simkl.state().busy, null, { timeout: 20000 });
  L = (await mlog()).slice(before);
  check("... and sent again with the next sync", L.filter((e) => e.p === "/scrobble/pause").length === 2 && (await page.evaluate(() => TV.simkl.state().waiting)) === 0, L.map((e) => e.p));

  // ---- changes on Simkl's side ----
  await mdo("unwatch-dune"); await mdo("ptw-dune84"); await mdo("office-unwatch-e3");
  before = (await mlog()).length;
  await page.evaluate(() => TV.simkl.sync(true));
  await page.waitForFunction(() => !TV.simkl.state().busy, null, { timeout: 15000 });
  await sleep(1500);
  L = (await mlog()).slice(before);
  const r2 = await page.evaluate(() => ({ dune21: $w("Dune", 2021), office13: $we("The Office", 1, 3), office14: $we("The Office", 1, 4), list: $list(), rw: $rw() }));
  check("delta asked with date_from", L.some((e) => e.p === "/sync/all-items" && e.q.date_from && e.q.extended === "full"));
  check("removals asked with simkl_ids_only", L.some((e) => e.p === "/sync/all-items" && e.q.extended === "simkl_ids_only"));
  check("unwatched on Simkl -> unticked here", r2.dune21 === false);
  check("... and out of Recently Watched", r2.rw.indexOf("Dune 2021") < 0, r2.rw);
  check("one episode unwatched on Simkl -> unticked, others stay", r2.office13 === false && r2.office14 === true);
  check("added to Plan to Watch on Simkl -> My List", r2.list.indexOf("Dune 1984") >= 0, r2.list);
  const r2b = await page.evaluate(() => ({ cw: $cw().map((x) => x.t), arrival: $w("Arrival") }));
  check("paused here, finished in another app -> ticked and out of Continue Watching", r2b.arrival && r2b.cw.indexOf("Arrival") < 0, r2b);
  check("a pause from another app still on Simkl stays", r2b.cw.indexOf("Parasite") >= 0, r2b.cw);
  await mdo("clear-playback");
  await page.evaluate(() => TV.simkl.sync(true));
  await page.waitForFunction(() => !TV.simkl.state().busy, null, { timeout: 15000 });
  await sleep(1500);
  const r2c = await page.evaluate(() => $cw().map((x) => x.t));
  check("a pause from another app taken out there -> out of Continue Watching here", r2c.indexOf("Parasite") < 0, r2c);

  // nothing changed: one small request
  before = (await mlog()).length;
  await page.evaluate(() => TV.simkl.sync(true));
  await page.waitForFunction(() => !TV.simkl.state().busy, null, { timeout: 15000 });
  L = (await mlog()).slice(before);
  check("nothing changed -> only /sync/activities", L.length === 1 && L[0].p === "/sync/activities", L.map((e) => e.p));
  // throttle
  before = (await mlog()).length;
  await page.evaluate(() => TV.simkl.fresh());
  await sleep(500);
  check("Home within 15 minutes -> no request", (await mlog()).length === before);

  // ---- a key refused: renewed once, then the request again ----
  await mdo("expire");
  before = (await mlog()).length;
  await page.evaluate(() => TV.simkl.sync(true));
  await page.waitForFunction(() => !TV.simkl.state().busy, null, { timeout: 15000 });
  L = (await mlog()).slice(before);
  check("401 -> key renewed -> request again", L.some((e) => e.p === "/oauth2/token" && e.body && /refresh_token/.test(JSON.stringify(e.body))) && L[L.length - 1].p === "/sync/activities", L.map((e) => e.p));

  // ---- home row and the Simkl settings page ----
  await page.evaluate(() => TV.shell.go("home", true));
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, "4-home.png") });
  await page.evaluate(() => { TV.shell.go("settings", true); TV.setup.media("simkl"); });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, "5-settings.png") });

  // ---- a restart: Simkl's ticks from the TV's own storage, before any request ----
  before = (await mlog()).length;
  await page.reload();
  await page.waitForFunction(() => window.TV && TV.data && TV.data.catalog() && TV.data.catalog().movies.items.length > 0, null, { timeout: 30000 });
  await page.evaluate(() => {
    window.$m = (t, y) => TV.data.catalog().movies.items.filter((x) => x.title === t && (!y || x.year === y))[0];
    window.$s = (t) => TV.data.catalog().series.items.filter((x) => x.title === t)[0];
    window.$ep = (show, s, e) => { var sh = $s(show); var x = sh.eps.filter((q) => q.season === s && q.episode === e)[0]; return { id: x.id, season: s, episode: e }; };
    window.$w = (t, y) => TV.data.watched($m(t, y));
    window.$we = (show, s, e) => TV.data.watched($s(show), $ep(show, s, e));
  });
  await sleep(1000);
  const r4 = await page.evaluate(() => ({ bb13: $we("Breaking Bad", 1, 3), office14: $we("The Office", 1, 4), linked: TV.simkl.linked() }));
  check("after a restart: still linked, ticks there before any request", r4.linked && r4.bb13 && r4.office14 && (await Promise.resolve(true)), r4);
  { const after = (await mlog()).slice(before); check("... only the launch check (/sync/activities), no library pulled", after.every((e) => e.p === "/sync/activities"), after.map((e) => e.p)); }

  // ---- unlink ----
  await page.evaluate(() => TV.simkl.unlink());
  await sleep(500);
  const r3 = await page.evaluate(() => ({ linked: TV.simkl.linked(), inception: $w("Inception"), bb13: $we("Breaking Bad", 1, 3), local: $w("Dune", 1984) }));
  check("unlinked: Simkl's ticks go, APL TV's own stay", !r3.linked && r3.bb13 === false && r3.local === true, r3);

  // ---- linked again, the library without a title APL TV had marked: APL TV's own mark stays, and goes up again ----
  await mdo("forget-dune84");
  before = (await mlog()).length;
  await page.evaluate(() => { TV.shell.go("settings", true); TV.setup.media("simkl"); });
  await page.waitForFunction(() => TV.simkl.linked() && TV.simkl.state().at > 0, null, { timeout: 30000 });
  await page.waitForFunction(() => !TV.simkl.state().busy, null, { timeout: 15000 });
  await sleep(7000);
  L = (await mlog()).slice(before);
  const r5 = await page.evaluate(() => ({ dune84: $w("Dune", 1984) }));
  check("linked again: APL TV's own watched mark kept", r5.dune84 === true, r5);
  check("... and sent to Simkl again", L.some((e) => e.p === "/sync/history" && (e.body.movies || []).some((m) => m.title === "Dune" && m.year === 1984)), L.map((e) => e.p));

  const errs = logs.filter((l) => /PAGEERROR|script error|promise refused/i.test(l));
  check("no script errors", errs.length === 0, errs);
  require("fs").writeFileSync(path.join(OUT, "app-log.txt"), logs.join("\n"));
  console.log(failures ? failures + " FAILED" : "ALL PASSED");
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
