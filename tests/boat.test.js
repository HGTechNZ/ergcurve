/*
 Boat Recorder automated test (boat/index.html), Node + jsdom + fake-indexeddb.

 Setup once, OUTSIDE the repo (nothing is installed into the repo):
     mkdir -p ~/boattest && cd ~/boattest && npm init -y && npm install jsdom@24 fake-indexeddb@6
 Run from the repo root:
     NODE_PATH=~/boattest/node_modules node tests/boat.test.js

 Runs in real time (about 45 s) using the built-in "Simulate 4" gates:
   1. Unit check of the drill stroke counter (only strokes whose catch is after the tap count).
   2. Full session on an eight, gates on seats 3-6 with a tandem (5 and 4 both bow side):
      drill, cancelled drill, rower change, end, export, checks on the export.
   3. Boat-size change doesn't pile gates onto one seat; settings survive a reload.
   4. Resume: the app is "killed" mid-session, reopened, resumed, ended; nothing lost or duplicated.
   5. Ready screen live rows, Copy diagnostics, error capture.
 Exit code 0 = all passed.
*/
"use strict";
const fs = require("fs"), path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

const HTML = fs.readFileSync(process.env.BOAT_HTML || path.join(__dirname, "..", "boat", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) pass++; else fail++; console.log((ok ? "  PASS  " : "  FAIL  ") + name + (!ok && detail !== undefined ? "  [" + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) + "]" : "")); }

const pageErrors = [];
process.on("unhandledRejection", e => pageErrors.push("unhandledRejection: " + (e && e.stack || e)));

// A fake GPS that moves north at 4 m/s, one fix a second
function fakeGeo(w) {
  let lat = -43.5, n = 0;
  return { watchPosition(ok) { const id = w.setInterval(() => { n++; lat += 4 / 111320; ok({ timestamp: Date.now(), coords: { latitude: lat, longitude: 172.6, accuracy: 5, speed: 4, heading: 0 } }); }, 1000); return id; }, clearWatch(id) { w.clearInterval(id); } };
}

// Fake NK EmPower gates for navigator.bluetooth: stream 10-byte packets at 20 Hz once the start command is written.
// dev.absent = true makes connect() hang (like an out-of-range gate) until disconnect() cancels it.
function fakeBt(w, names, stats) {
  const devs = names.map(name => {
    const dev = new w.EventTarget(); dev.name = name; dev.id = name; dev.absent = false; dev.streaming = false; dev.connects = 0;
    let connected = false, pending = null, clk = 0, iv = null, hooks = 0;
    const d1 = new w.EventTarget(); d1.value = null;
    const origAdd = d1.addEventListener.bind(d1); d1.addEventListener = (t, f, o) => { if (t === "characteristicvaluechanged") hooks++; dev.dataHooks = hooks; origAdd(t, f, o); };
    d1.startNotifications = async () => { if (!connected) throw new Error("GATT Server is disconnected"); if (!iv) iv = w.setInterval(() => {
      if (!connected || !dev.streaming) return; clk = (clk + 50) & 0xFFFF; const v = new DataView(new ArrayBuffer(10));
      v.setUint16(0, clk, true); v.setInt16(2, 120, true); v.setUint16(4, 0x8000, true); v.setInt16(6, Math.round(15000 * Math.sin(Date.now() / 500)), true); v.setInt16(8, 0, true);
      d1.value = v; d1.dispatchEvent(new w.Event("characteristicvaluechanged")); }, 50); };
    const cmd = { writeValueWithResponse: async () => { if (!connected) throw new Error("GATT Server is disconnected"); dev.streaming = true; dev.starts = (dev.starts || 0) + 1; } };
    const svc = { getCharacteristic: async u => { if (!connected) throw new Error("GATT Server is disconnected"); if (u === "battery_level") return { readValue: async () => new DataView(new Uint8Array([77]).buffer) }; if (/^12630001/.test(u)) return d1; if (/^85920100/.test(u)) return { startNotifications: async () => {} }; if (/^85920200/.test(u)) return cmd; throw new Error("no char " + u); } };
    const server = { getPrimaryService: async () => { if (!connected) throw new Error("GATT Server is disconnected"); await new Promise(r => setTimeout(r, 20)); return svc; } };
    dev.gatt = {
      get connected() { return connected; },
      connect: () => { stats.active++; stats.max = Math.max(stats.max, stats.active); dev.connects++;
        return new Promise((res, rej) => { pending = rej; const go = () => { if (dev.absent) return; clearInterval(t); pending = null; connected = true; stats.active--; res(server); }; const t = setInterval(go, 30); go(); pending = e => { clearInterval(t); stats.active--; rej(e); }; }); },
      disconnect: () => { if (pending) { const r = pending; pending = null; r(new Error("Connection attempt aborted")); return; } if (connected) { connected = false; dev.streaming = false; dev.dispatchEvent(new w.Event("gattserverdisconnected")); } }
    };
    dev.drop = () => { if (connected) { connected = false; dev.streaming = false; dev.dispatchEvent(new w.Event("gattserverdisconnected")); } };
    return dev;
  });
  return { devs, bt: { getDevices: async () => devs, requestDevice: async () => devs[0] } };
}

async function load(idb, ls, bt) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented: (navigation|HTMLMediaElement)/.test(e.message)) pageErrors.push("jsdomError: " + (e.stack || e.message)); });
  vc.on("error", (...a) => pageErrors.push("console.error: " + a.join(" ")));
  const blobs = [], clip = [];
  const dom = new JSDOM(HTML, {
    url: "https://hgtechnz.github.io/ergcurve/boat/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = idb; w.IDBKeyRange = IDBKeyRange;
      Object.entries(ls || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.URL.createObjectURL = b => { blobs.push(b); return "blob:test/" + blobs.length; };
      w.HTMLAnchorElement.prototype.click = function () {}; // no navigation for downloads
      Object.defineProperty(w.navigator, "geolocation", { value: fakeGeo(w), configurable: true });
      if (bt) { const f = fakeBt(w, bt.names, bt.stats); bt.devs = f.devs; Object.defineProperty(w.navigator, "bluetooth", { value: f.bt, configurable: true }); }
      Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async t => { clip.push(t); } }, configurable: true });
    }
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.eval("db"); i++) await sleep(20);
  return { dom, w, d: w.document, blobs, clip, $: id => w.document.getElementById(id) };
}
const lsDump = w => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; };
const blobText = (w, b) => new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(b); });
const click = el => { if (!el) throw new Error("missing element"); el.click(); };
const onScreen = (p, s) => p.$("s-" + s).classList.contains("on");
async function confirmYes(p) { for (let i = 0; i < 50 && !p.$("m-confirm").classList.contains("on"); i++) await sleep(20); click(p.$("mcYes")); }
function setSelect(p, sel, val) { const el = p.d.querySelector(sel); if (!el) throw new Error("missing " + sel); el.value = String(val); el.dispatchEvent(new p.w.Event("change", { bubbles: true })); }
function setInput(p, sel, val) { const el = p.d.querySelector(sel); if (!el) throw new Error("missing " + sel); el.value = val; el.dispatchEvent(new p.w.Event("input", { bubbles: true })); el.dispatchEvent(new p.w.Event("change", { bubbles: true })); }
const seatOfSer = (p, ser) => p.w.eval(`gates.find(g => g.ser === "${ser}").seat`);
function chunksOf(idb, sid) {
  return new Promise((res, rej) => { const r = idb.open("boatRecorder", 1); r.onsuccess = () => { const q = r.result.transaction("chunks").objectStore("chunks").index("sid").getAll(sid); q.onsuccess = () => { r.result.close(); res(q.result); }; q.onerror = rej; }; r.onerror = rej; });
}
async function exportVia(p, btn) { const n = p.blobs.length; click(btn); for (let i = 0; i < 100 && p.blobs.length === n; i++) await sleep(20); if (p.blobs.length === n) throw new Error("no export blob"); return JSON.parse(await blobText(p.w, p.blobs[p.blobs.length - 1])); }

(async () => {
  // ---------- 1. drill stroke counter unit check ----------
  console.log("1. Drill stroke counter");
  {
    const p = await load(new IDBFactory());
    const r = p.w.eval(`(() => {
      const saved = { on: rec.on, meta: rec.meta };
      rec.on = true; rec.meta = { strokes: 0, events: [] }; rec.t0 = 0;
      const g = { seat: 8, conn: true, strokes: 0, lastCycle: 0, lastCatchT: 0, st: { mode: "catch", ext: null, extT: 0, catchT: null, catchA: null, finA: null } };
      gates.push(g);
      // strokes: catch at k*2500 ms (-55°), finish at k*2500+1000 (+35°)
      const ang = t => { const ph = (t % 2500) / 2500; return ph < 0.4 ? -55 + 90 * (1 - Math.cos(Math.PI * ph / 0.4)) / 2 : 35 - 90 * (1 - Math.cos(Math.PI * (ph - 0.4) / 0.6)) / 2; };
      drill.on = true; drill.n = 0; drill.start = 5200;   // tap just after the catch at 5000 -> that stroke must NOT count
      const counts = {};
      for (let t = 0; t <= 15000; t += 50) { feed(g, t, ang(t)); counts[t] = drill.n; }
      const out = { at5900: counts[5900], at8900: counts[8900], at11400: counts[11400], end: drill.n, total: g.strokes, sess: rec.meta.strokes };
      gates.splice(gates.indexOf(g), 1); drill.on = false; drill.n = 0; rec.on = saved.on; rec.meta = saved.meta;
      return out; })()`);
    // catches at 0,2500,5000(before tap),7500,10000,12500,15000; finish peak ~1000 ms later, detected ~250 ms after the peak
    check("stroke whose catch was before the tap is not counted", r.at5900 === 0, r);
    check("first stroke after the tap counts at its finish (not a stroke late)", r.at8900 === 1, r);
    check("second drill stroke counted", r.at11400 === 2, r);
    check("drill total = strokes with catch after tap (7.5, 10, 12.5 s)", r.end === 3, r);
    check("session stroke count includes all strokes", r.sess === 6 && r.total === 6, r);
    p.w.close();
  }

  // ---------- 2. full session on an eight ----------
  console.log("2. Session on an eight, simulated gates on seats 3-6");
  const idb = new IDBFactory();
  let p = await load(idb);
  check("home screen shows version", /v1\.\d/.test(p.$("verTxt").textContent), p.$("verTxt").textContent);
  click(p.$("btnNew")); check("New session opens Connect", onScreen(p, "connect"));
  click(p.d.querySelector('[data-size="8"]')); check("boat size set to 8", p.w.eval("N()") === 8);
  click(p.$("btnSim")); await sleep(100);
  check("Simulate 4 adds 4 gates", p.w.eval("gates.length") === 4);
  const sers = p.w.eval("gates.map(g => g.ser)");
  [6, 5, 4, 3].forEach((seat, i) => setSelect(p, `[data-seatsel="${sers[i]}"]`, seat));
  check("gates moved to seats 6,5,4,3", JSON.stringify(sers.map(s => seatOfSer(p, s))) === "[6,5,4,3]", sers.map(s => seatOfSer(p, s)));
  const sideOf = seat => p.w.eval(`gateOnSeat(${seat}).side`);
  check("default sides alternate (6 stroke, 5 bow, 4 stroke, 3 bow)", [6, 5, 4, 3].map(sideOf).join() === "stroke,bow,stroke,bow", [6, 5, 4, 3].map(sideOf));
  setSelect(p, `[data-sidesel="${sers[2]}"]`, "bow"); // tandem: seat 4 rows bow side like seat 5
  check("tandem: seat 4 now bow side", sideOf(4) === "bow");
  for (const [seat, nm] of Object.entries({ 6: "Ari", 5: "Ben", 4: "Cam", 3: "Dan" })) setInput(p, `[data-name="${seat}"]`, nm);
  check("rower names saved per seat", p.w.eval("JSON.stringify(S.names)") === JSON.stringify({ 3: "Dan", 4: "Cam", 5: "Ben", 6: "Ari" }), p.w.eval("JSON.stringify(S.names)"));
  click(p.d.querySelector('#s-connect [data-go="rig"]')); check("Rig screen", onScreen(p, "rig"));
  p.$("rBoat").value = "Test Eight"; p.$("rOar").value = "372";
  click(p.d.querySelector('#s-rig [data-go="cal"]')); check("Calibrate screen", onScreen(p, "cal"));
  click(p.d.querySelector('#s-cal [data-go="ready"]')); check("Ready screen", onScreen(p, "ready"));
  await sleep(1200);
  const rows = [...p.d.querySelectorAll("#liveGates .lg")];
  check("Ready shows a live row per gate", rows.length === 4, rows.length);
  check("live rows show angles from the gates", rows.every(r => /°$/.test(r.querySelector("[data-a]").textContent)), rows.map(r => r.querySelector("[data-a]").textContent));
  check("live rows in seat order, stroke end first", rows.map(r => r.querySelector("b").firstChild.textContent).join() === "6,5,4,3", rows.map(r => r.querySelector("b").firstChild.textContent));
  click(p.$("btnStart")); click(p.$("btnStart")); // double tap
  for (let i = 0; i < 50 && !onScreen(p, "cox"); i++) await sleep(20);
  check("Start session opens cox screen", onScreen(p, "cox"));
  const sid = p.w.eval("rec.id");
  await sleep(6000);
  check("strokes counting on cox screen", +p.$("vStk").textContent >= 1, p.$("vStk").textContent);
  check("rate shown", /^\d+$/.test(p.$("vRate").textContent), p.$("vRate").textContent);
  check("GPS distance counting", +p.$("vDist").textContent.replace(/,/g, "") > 0, p.$("vDist").textContent);
  check("split shown", /^\d:\d\d\.\d$/.test(p.$("vSplit").textContent), p.$("vSplit").textContent);
  // drill 1 (kept)
  click(p.$("btnDrill")); check("drill screen on", p.$("drillPanels").style.display === "");
  click(p.d.querySelector('[data-dn="Legs only"]'));
  await sleep(9000);
  const shown = +p.$("vDrillN").textContent;
  click(p.$("btnStopDrill")); check("drill stopped, back to live view", p.$("livePanels").style.display === "");
  // drill 2 (cancelled within 5 s)
  click(p.$("btnDrill")); await sleep(1500); click(p.$("btnStopDrill"));
  check("drill stopped within 5 s doesn't count", p.w.eval("rec.meta.drills") === 1, p.w.eval("rec.meta.drills"));
  // rower change on seat 5
  click(p.$("btnRower")); click(p.d.querySelector('[data-mrs="5"]')); p.$("mrName").value = "Eli"; click(p.$("mrSave"));
  check("rower changed on seat 5", p.w.eval("S.names[5]") === "Eli");
  // an uncaught error during the session is logged
  p.w.eval('setTimeout(() => { throw new Error("test uncaught boom"); }, 0); const ev = new Event("unhandledrejection"); ev.reason = new Error("test rejection boom"); dispatchEvent(ev);'); // jsdom doesn't raise unhandledrejection itself
  await sleep(2600);
  click(p.$("btnEnd")); await confirmYes(p);
  for (let i = 0; i < 100 && !onScreen(p, "end"); i++) await sleep(20);
  check("End session shows Session saved", onScreen(p, "end"));
  check("end screen lists the drill", /Legs only/.test(p.$("endDrills").textContent), p.$("endDrills").textContent);
  const ex = await exportVia(p, p.$("btnExportEnd"));
  check("export format", ex.format === "cbhs-boat-recorder/1");
  check("export status saved", ex.meta.status === "saved");
  check("export has packets", ex.packets.length > 500, ex.packets.length);
  check("packets only from seats 3-6", [...new Set(ex.packets.map(x => x[1]))].sort().join() === "3,4,5,6", [...new Set(ex.packets.map(x => x[1]))]);
  check("meta: boat size 8, boat name", ex.meta.boatSize === 8 && ex.meta.boat === "Test Eight", [ex.meta.boatSize, ex.meta.boat]);
  const mg = ex.meta.gates.slice().sort((a, b) => b.seat - a.seat);
  check("meta gates: seats and sides (tandem 5 & 4 bow)", mg.map(g => g.seat + g.side[0]).join() === "6s,5b,4b,3b", mg.map(g => g.seat + g.side[0]));
  const E = t => ex.events.filter(e => e.type === t);
  check("events: 2 drill starts, 1 end, 1 cancel", E("drill_start").length === 2 && E("drill_end").length === 1 && E("drill_cancel").length === 1, ex.events.map(e => e.type));
  const de = E("drill_end")[0] || {};
  check("drill name and stroke count recorded", de.name === "Legs only" && de.strokes >= 2 && de.strokes <= 4, de);
  check("drill strokes in export = what the cox saw", de.strokes >= shown && de.strokes - shown <= 1, [de.strokes, shown]);
  check("rower events: 4 at start + Eli on 5", E("rower").length === 5 && E("rower").some(e => e.seat === 5 && e.name === "Eli"), E("rower"));
  check("end event present", E("end").length === 1);
  check("errors logged as session events", E("error").some(e => /uncaught boom/.test(e.msg)) && E("error").some(e => /rejection boom/.test(e.msg)), E("error"));
  check("meta stroke count > 0", ex.meta.strokes > 0, ex.meta.strokes);
  check("GPS fixes exported and distance > 0", ex.gps.length >= 10 && ex.meta.dist > 0, [ex.gps.length, ex.meta.dist]);
  const chunks = await chunksOf(idb, sid), seqs = chunks.map(c => c.seq);
  check("chunk seqs unique", new Set(seqs).size === seqs.length, seqs);
  check("only one session was started despite the double tap", (await new Promise(r => { const o = idb.open("boatRecorder", 1); o.onsuccess = () => { const q = o.result.transaction("sessions").objectStore("sessions").getAll(); q.onsuccess = () => { o.result.close(); r(q.result.length); }; }; })) === 1);
  const key = x => x[1] + ":" + x[0] + ":" + x[2];
  check("no duplicate packets", new Set(ex.packets.map(key)).size === ex.packets.length);
  check("events also stored in meta", (ex.meta.events || []).length === ex.events.length, [(ex.meta.events || []).length, ex.events.length]);
  // Home: saved list, diagnostics
  click(p.d.querySelector('#s-end [data-go="home"]')); await sleep(200);
  check("saved session listed on Home", p.d.querySelectorAll("#sessList [data-exp]").length === 1);
  const ex2 = await exportVia(p, p.d.querySelector("#sessList [data-exp]"));
  check("export from Home matches", ex2.packets.length === ex.packets.length);
  click(p.$("btnDiag")); for (let i = 0; i < 50 && !p.clip.length; i++) await sleep(20);
  const diag = p.clip[0] || "";
  check("Copy diagnostics copies version, gates, storage, errors", /Boat Recorder v1\.1/.test(diag) && /Gates \(4\)/.test(diag) && /Storage/.test(diag) && /test uncaught boom/.test(diag), diag);
  // boat size change: 4 gates on 6,5,4,3 in an eight -> a four
  click(p.$("btnNew")); click(p.d.querySelector('[data-size="4"]'));
  const seats4 = p.w.eval("gates.map(g => g.seat).sort()");
  check("eight -> four keeps one gate per seat, all within 1-4", JSON.stringify(seats4) === "[1,2,3,4]", seats4);
  click(p.d.querySelector('[data-size="2"]'));
  check("can't pick a pair with 4 gates", p.w.eval("N()") === 4);
  click(p.d.querySelector('[data-size="8"]'));
  // settings survive reload
  const ls1 = lsDump(p.w); p.w.close();
  check("boat.settings stored", !!JSON.parse(ls1["boat.settings"]).names);
  p = await load(idb, ls1);
  check("settings reload: size 8 + names kept", p.w.eval("N()") === 8 && p.w.eval("S.names[3]") === "Dan");
  p.w.close();

  // ---------- 3. fake Bluetooth gates: restore, reconnect forever, stalled stream ----------
  console.log("3. Fake Bluetooth gates: connect one at a time, reconnect while recording");
  {
    const idb3 = new IDBFactory(), stats = { active: 0, max: 0 }, names = ["EmPower 1100003", "EmPower 1100004", "EmPower 1100005", "EmPower 1100006"];
    const assign = {}; names.forEach((n, i) => { assign[n.slice(-7)] = { seat: 3 + i, side: i === 1 ? "bow" : (8 - 3 - i) % 2 ? "bow" : "stroke" }; });
    const bt = { names, stats };
    // also a 5th permitted gate that is not in this boat: must not be restored
    bt.names = names.concat(["EmPower 1109999"]);
    const ls = { "boat.settings": JSON.stringify({ size: 8, names: { 3: "A", 4: "B", 5: "C", 6: "D" }, recent: [], rig: { boat: "", oar: "", inb: "", seats: {} }, lastRig: null, assign, lastGates: names.map(n => n.slice(-7)) }) };
    p = await load(idb3, ls, bt); p.w.eval("CONNECT_TIMEOUT = 400; RETRY_MAX = 1000"); // short limits so the test runs fast (real: 10 s, backoff to 10 s)
    for (let i = 0; i < 100 && p.w.eval("gates.filter(g => g.conn).length") < 4; i++) await sleep(50);
    check("4 gates restored and connected at boot", p.w.eval("gates.filter(g => g.conn).length") === 4 && p.w.eval("gates.length") === 4, p.w.eval("gates.map(g => g.ser + ':' + g.conn)"));
    check("gate not in the last session is not restored", !p.w.eval("gates.some(g => g.ser === '1109999')"));
    check("connections made one at a time", stats.max === 1, stats);
    check("restored gates keep their seats (3-6)", p.w.eval("gates.map(g => g.seat).sort().join()") === "3,4,5,6");
    click(p.$("btnNew")); click(p.d.querySelector('#s-connect [data-go="rig"]')); click(p.d.querySelector('#s-rig [data-go="cal"]')); click(p.d.querySelector('#s-cal [data-go="ready"]'));
    await sleep(800);
    check("Ready live rows show real gate angles", [...p.d.querySelectorAll("#liveGates [data-a]")].every(e => /°$/.test(e.textContent)), [...p.d.querySelectorAll("#liveGates [data-a]")].map(e => e.textContent));
    check("Ready live rows show force", [...p.d.querySelectorAll("#liveGates [data-f]")].every(e => e.textContent === "120"), [...p.d.querySelectorAll("#liveGates [data-f]")].map(e => e.textContent));
    click(p.$("btnStart")); for (let i = 0; i < 50 && !onScreen(p, "cox"); i++) await sleep(20);
    await sleep(1000);
    const d5 = bt.devs[2], d6 = bt.devs[3];
    d5.absent = true; d5.drop();                 // seat 5 goes out of range for ~21 s (more than the old 5-attempt limit)
    d6.streaming = false;                        // seat 6 stays "connected" but stops sending
    await sleep(2000);
    check("cox warning names the missing seat", /5/.test(p.$("warnBar").textContent) && p.$("warnBar").classList.contains("on"), p.$("warnBar").textContent);
    await sleep(19000);
    const tries = d5.connects;
    check("still retrying seat 5 after more than 5 attempts", tries >= 6, tries);
    check("seat 6 stalled stream was restarted", d6.streaming && (d6.starts || 0) >= 2, d6.starts);
    d5.absent = false;
    for (let i = 0; i < 100 && !p.w.eval("gateOnSeat(5).conn"); i++) await sleep(100);
    check("seat 5 reconnects when back in range", p.w.eval("gateOnSeat(5).conn"));
    check("only one data handler per gate after reconnects", bt.devs.slice(0, 4).every(d => d.dataHooks === 1), bt.devs.map(d => d.dataHooks));
    check("connections still one at a time", stats.max === 1, stats);
    await sleep(2500);
    click(p.$("btnEnd")); await confirmYes(p); for (let i = 0; i < 100 && !onScreen(p, "end"); i++) await sleep(20);
    const bx = await exportVia(p, p.$("btnExportEnd"));
    const ev = t => bx.events.filter(e => e.type === t);
    check("disconnect event for seat 5", ev("disconnect").some(e => e.seat === 5), ev("disconnect"));
    const rc = ev("connect").find(e => e.seat === 5);
    check("reconnect event for seat 5 with attempt count", rc && rc.attempts >= 6, rc);
    check("restart_stream event for seat 6", ev("restart_stream").some(e => e.seat === 6), ev("restart_stream"));
    check("connect failures logged as error events", ev("error").some(e => e.src === "bt"), ev("error").slice(0, 3));
    const lastResume = bx.events.find(e => e.type === "connect" && e.seat === 5).t;
    check("seat 5 data recorded after reconnecting", bx.packets.some(x => x[1] === 5 && x[0] > lastResume));
    check("packets carry decoded fields (force 120)", bx.packets.length > 100 && bx.packets.every(x => x[3] === 120), bx.packets[0]);
    check("meta gates: 4 real gates on 3-6", bx.meta.gates.map(g => g.seat).sort().join() === "3,4,5,6" && bx.meta.gates.every(g => !g.sim));
    p.w.eval("CONNECT_TIMEOUT = 0; gates.forEach(g => { g.sim = true; })"); // stop the supervisor touching the fakes
    p.w.close();
  }

  // ---------- 4. resume ----------
  console.log("4. Resume after the app is killed mid-session");
  const idb2 = new IDBFactory();
  p = await load(idb2);
  click(p.$("btnNew")); click(p.$("btnSim")); await sleep(100);
  click(p.d.querySelector('#s-connect [data-go="rig"]')); click(p.d.querySelector('#s-rig [data-go="cal"]')); click(p.d.querySelector('#s-cal [data-go="ready"]'));
  click(p.$("btnStart")); for (let i = 0; i < 50 && !onScreen(p, "cox"); i++) await sleep(20);
  const rsid = p.w.eval("rec.id");
  click(p.$("btnDrill")); // a drill is running when the app dies
  await sleep(4500);
  const beforeKill = (await chunksOf(idb2, rsid)).reduce((n, c) => n + c.p.length, 0);
  const lsR = lsDump(p.w); p.w.close(); // killed: no end, no pagehide flush
  await sleep(1500);
  p = await load(idb2, lsR); await sleep(200);
  check("Resume card shown after reopening", p.$("resumeCard").style.display === "", p.$("resumeCard").style.display);
  click(p.$("btnResume")); for (let i = 0; i < 50 && !onScreen(p, "cox"); i++) await sleep(20);
  check("Resume opens cox screen with the same session", onScreen(p, "cox") && p.w.eval("rec.id") === rsid);
  click(p.$("btnResume")); // double tap: must not start anything new
  p.w.eval("startSim()"); await sleep(4500);
  click(p.$("btnEnd")); await confirmYes(p); for (let i = 0; i < 100 && !onScreen(p, "end"); i++) await sleep(20);
  const rx = await exportVia(p, p.$("btnExportEnd"));
  const rch = await chunksOf(idb2, rsid), rseq = rch.map(c => c.seq);
  check("resumed export saved", rx.meta.status === "saved");
  check("chunk seqs unique after resume", new Set(rseq).size === rseq.length, rseq);
  check("packets before the kill are all still there", rx.packets.filter(x => x[0] < rx.events.find(e => e.type === "resume").t).length === beforeKill, [beforeKill]);
  check("packets after resume recorded", rx.packets.some(x => x[0] > rx.events.find(e => e.type === "resume").t));
  check("no duplicate packets after resume", new Set(rx.packets.map(key)).size === rx.packets.length);
  const rev = rx.events.find(e => e.type === "resume");
  check("resume event marks the gap", rev && rev.gapFrom > 0 && rev.t > rev.gapFrom, rev);
  check("drill left running is closed as interrupted", rx.events.some(e => e.type === "drill_interrupted" && e.n === 1), rx.events.map(e => e.type));
  check("timeline shows the gap", p.$("endTl").querySelectorAll("s").length >= 1);
  check("packets time-ordered per seat", [1, 2, 3, 4].every(s => { const t = rx.packets.filter(x => x[1] === s).map(x => x[0]); return t.every((v, i) => !i || v >= t[i - 1]); }));
  p.w.close();

  // ---------- errors ----------
  const unexpected = pageErrors.filter(e => !/test (uncaught|rejection) boom/.test(e));
  check("no unexpected page errors", unexpected.length === 0, unexpected);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST CRASHED", e); process.exit(2); });
