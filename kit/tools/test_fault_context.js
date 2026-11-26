'use strict';
// Fault Scanner > Fault details and Response times: the standard 19 03 / 19 04 / 19 06 replies taken apart, values
// with unknown lengths kept raw, nothing named by a guess, only service 19 ever sent for it, and the timing of each
// unit's answers. Against a stubbed diagnostic link; no SDK or car needed:
//   node kit/tools/test_fault_context.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'dtc_scanner');
const FC = require(path.join(APP, 'fault_context'));
const { Timing, wrap } = require(path.join(APP, 'timing'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const DTC = [0x12, 0x03, 0x08];

/** A unit at 0x12 with fault 120308: snapshot records 1 and 2 (one value each) and 3 (three values), extended 01. */
function reply(sid, data) {
    if (sid !== 0x19) return [0x7F, sid, 0x11];
    const sub = data[0], rec = data[4];
    if (sub === 0x03) return [0x59, 0x03].concat(DTC, [0x01], DTC, [0x02], DTC, [0x03], [0xAA, 0xBB, 0xCC, 0x01]);
    if (sub === 0x04 && rec < 3) return [0x59, 0x04].concat(DTC, [0x2F, rec, 0x01, 0x17, 0x00, 0x00, 0xBC, rec * 16]);
    if (sub === 0x04 && rec === 3) return [0x59, 0x04].concat(DTC, [0x2F, 3, 0x03, 0x17, 0x01, 0x00, 0x5E, 0x12, 0x17, 0x02, 0x0C]);
    if (sub === 0x06 && rec === 1) return [0x59, 0x06].concat(DTC, [0x2F, 0x01, 0x05]);
    if (sub === 0x06 && rec === 2) return [0x7F, 0x19, 0x31];
    return [0x59, sub].concat(DTC, [0x2F]);
}

/* ---------- parsing ---------- */
ok(FC.parseIds(reply(0x19, [0x03]), '120308').join() === '1,2,3', '19 03: the snapshot records of this fault only');
let s = FC.parseSnapshot(reply(0x19, [0x04].concat(DTC, [1])));
ok(s && s.rec === 1 && s.values.length === 1 && s.values[0].did === 0x1700 && s.values[0].bytes.join() === [0x00, 0xBC, 0x10].join(), '19 04, one value: its identifier and bytes');
s = FC.parseSnapshot(reply(0x19, [0x04].concat(DTC, [3])));
ok(s && s.count === 3 && s.values[0].did === 0x1701 && s.values[0].bytes === null && s.rest.length === 6, '19 04, three values: lengths unknown, the bytes kept whole (raw)');
const e = FC.parseExtended(reply(0x19, [0x06].concat(DTC, [1])));
ok(e && e.rec === 1 && e.bytes.join() === '5', '19 06: an extended record\'s bytes');
ok(FC.parseExtended([0x59, 0x06].concat(DTC, [0x2F])) === null, '19 06 with no record: none');
ok(/^00 BC 10  \(as a number: 48144\)$/.test(FC.rawText([0x00, 0xBC, 0x10])), 'raw text: hex and the number, no name');
const bits = FC.statusBits(0x09);
ok(bits.filter((b) => b.on).map((b) => b.label).join('|') === 'Failing right now|Confirmed and stored', 'status 0x09 in words');
let threw = 0;
[[0x14, [0xFF, 0xFF, 0xFF]], [0x19, [0x02, 0x0C]], [0x31, [0x01]]].forEach(([sid, d]) => { try { FC.check(sid, d); } catch (err) { threw++; } });
ok(threw === 3, 'check(): 14, 19 02 and 31 refused');
ok(FC.series([{ rec: 1, values: [{ did: 0x1700, bytes: [1, 2] }] }, { rec: 2, values: [{ did: 0x1700, bytes: [1, 3] }] }])[0].points.map((p) => p.value).join() === '258,259',
    'one value over several snapshots: a series for the chart');

(async () => {
    /* ---------- reading one fault ---------- */
    const sent = [];
    const fake = { physical: async (target, sid, data, ms, accept) => { sent.push([target, sid].concat(data)); const r = reply(sid, data); return accept && !accept(r) ? null : r; } };
    const c = await FC.readContext(fake, 0x12, '120308');
    ok(c.status === 0x2F && c.snapshots.length === 3 && c.extended.length === 1, 'readContext: 3 snapshots, 1 extended record, the status byte');
    ok(c.requests === 8 && sent.every((r) => r[1] === 0x19) && sent.every((r) => [3, 4, 6].indexOf(r[2]) >= 0), 'only 19 03 / 04 / 06 sent (' + c.requests + ')');
    ok(c.refused['06'] === 0x31, 'a refused record is noted, not fatal');
    const none = await FC.readContext({ physical: async () => null }, 0x12, '120308');
    ok(none.noAnswer && none.requests === 1, 'a unit that does not answer: one request, then stop');

    /* ---------- timing ---------- */
    let now = 1000;
    const tm = new Timing(() => now);
    const d = {
        send: async () => 'NO_ERROR',
        physical: async function (target, sid, data, ms, accept, opts) { await this.send(); now += 40; if (target === 0x12) { opts.onPending(); now += 60; } return target === 0x5D ? null : [0x62]; },
        functional: async function (sid, data, opts) { await this.send(); now += 25; opts.onReply(0x40, 1); now += 15; opts.onReply(0x12, 2); return new Map(); },
    };
    wrap(d, tm);
    await d.physical(0x12, 0x19, [3]); await d.physical(0x40, 0x19, [3]); await d.physical(0x5D, 0x19, [3]); await d.functional(0x19, [2, 0x0C]);
    const v = tm.view(now);
    const u12 = v.units.find((u) => u.addr === 0x12), u40 = v.units.find((u) => u.addr === 0x40);
    ok(v.sent === 4 && v.answered === 4 && v.missed === 1 && v.waits === 1, 'counts: 4 sent, 4 answers, 1 missed, 1 pending wait');
    ok(u12.max === 100 && u12.n === 2 && u12.waits === 1 && u40.avg === 32.5, 'per unit: slowest, average and waits (pending counted in the time)');
    ok(v.perSec[59] === 4 && v.perSec.reduce((a, b) => a + b, 0) === 4, 'requests per second over the last 60 s');

    /* ---------- the app: scan, open a fault, Response times ---------- */
    const all = [];
    class FakeDiag {
        constructor() { this.available = true; this.busy = 0; }
        async init() { return this; }
        async send(target, sid) { all.push(sid); return 'NO_ERROR'; }
        async functional(sid, params, opts) {
            await this.send(0xDF, sid);
            const m = new Map();
            if (params[0] === 0x02) { m.set(0x12, [0x59, 0x02, 0xFF].concat(DTC, [0x2F])); if (opts && opts.onReply) opts.onReply(0x12, 1); }
            return m;
        }
        async physical(target, sid, data, ms, accept) { await this.send(target, sid); const r = reply(sid, data); return accept && !accept(r) ? null : r; }
    }
    let impl = null;
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req === './kit/mgu') return { run: (i) => { impl = i; } };
        if (req === './kit/diag') { const real = load.call(this, path.join(KIT, 'diag'), parent, isMain); return Object.assign({}, real, { Diag: FakeDiag }); }
        if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
        return load.call(this, req, parent, isMain);
    };
    require(path.join(APP, 'main.js'));
    const { Recorder } = require(path.join(KIT, 'record'));
    const themes = require(path.join(KIT, 'themes'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultctx-'));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const S = {}; spec.settings.forEach((x) => { if (x.key) S[x.key] = x.default; }); S.autoScan = false; S.demo = 'off';
    const noop = () => {}, clicks = {}, vis = [];
    let frame = null, tab = null, texts = [];
    await impl.start({
        log: { info: noop, warn: noop, error: noop }, dataDir: dir, spec,
        settings: { get: (k) => S[k], onChange: noop },
        signals: { watch: async () => ({ shutdown: async () => {} }) },
        ui: { text: noop, image: async () => {}, onClick: (b, fn) => { clicks[b] = fn; }, onVisible: (fn) => vis.push(fn), onFocus: noop, isVisible: () => true },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => { const cv = new Recorder(w, h), text = cv.text.bind(cv); texts = []; cv.text = (x, ...a) => { texts.push(String(x)); return text(x, ...a); }; return cv; },
        hideButton: noop, onLayout: noop, onTab: (fn) => { tab = fn; }, onScroll: noop, loop: (n, f, fn) => { frame = fn; return { kick: noop }; },
        settingsRow: noop,
    });
    const draw = async () => { await frame(); return texts.join(' | '); };
    vis.forEach((f) => f('MAIN', true)); await tick();
    clicks.BTN_SCAN(); await tick(80);
    ok(/120308/.test(await draw()), 'the scan lists fault 120308');
    const scanSent = all.splice(0);
    clicks.BTN_DETAIL(); await tick(80);
    let t = await draw();
    ok(/status byte 0x2F/.test(t) && /Failing right now/.test(t) && /Confirmed and stored/.test(t) && /SNAPSHOTS/.test(t), 'Fault details: the status bits in words, what was stored');
    ok(/Snapshot 1, value 0x1700/.test(t) && /as a number: 48144/.test(t), 'a snapshot value shown raw with its identifier');
    ok(/Snapshot 3, 2 more values together/.test(t) && /Extra record 01/.test(t), 'unsplittable values kept together; the extended record');
    ok(/VALUES NAMED/.test(t) && /nothing is named by a guess/.test(t), 'says plainly that names are not known');
    ok(/Value 0x1700 in each snapshot/.test(t), 'a chart of the value over the snapshots');
    tab(3); await tick();
    t = await draw();
    ok(/bar: average/.test(t) && /by this app/.test(t) && /not visible to an app/.test(t) && / ms/.test(t), 'Response times page: per unit, our requests, the note');
    ok(all.length === 8 && all.every((x) => x === 0x19), 'opening the fault sent service 19 only (' + all.length + ' requests)');
    ok(scanSent.concat(all).indexOf(0x14) < 0, 'nothing in the flow cleared faults (no service 14)');
    console.log('fault context: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.log('FAIL ' + (err && err.stack || err)); process.exit(1); });
