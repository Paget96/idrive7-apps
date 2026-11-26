'use strict';
/**
 * Fault Scanner - reads the fault memory of every control unit over the head
 * unit's diagnostic transport (TASU, see diag.js) and can clear it.
 *
 *   Scan  : UDS 19 02 <mask> to all ECUs (0xDF), like BMW's own teleservice
 *           job READ_PRIMARY_DTCS; optional info memory 19 17 <mask> 01.
 *   Clear : UDS 14 FF FF FF to all control units at once, then to each unit with faults that did not confirm
 *           (press twice to confirm), then scans again.
 *   Check Control: the active messages from CheckControlMaster, named via the
 *           cluster's KombiInterface_2 lists.
 *   Health report (Settings > Health report as QR): the faults, Check Control, the 12 V battery's charge, the oil and
 *           coolant and the service items (KombiInterface_2 cbsDataServiceList, as the Service app reads them) on
 *           one plain-text report for a phone camera; read while the page shows, like Check Control.
 *
 * Fault details (a fault tapped, or Fault details): what the unit stored with it, read then from that unit alone
 *           (fault_context.js: 19 03 / 19 04 / 19 06, reads only): the status bits in words, the snapshot records and
 *           extended data records. BMW doesn't publish what they hold and the repo has no table for them, so they
 *           show as bytes, never named by a guess.
 *   Response times: how fast each unit answered this app and our own requests per second (timing.js); the real
 *           bus load is not visible to an app.
 *
 * Pages: faults (6 per page) -> Check Control -> control units that answered -> response times. Where the kit runs the
 * screen, all the faults are on one page and each list scrolls (a finger, or the controller turned on it).
 * Fault codes are BMW hex codes (as BMW's diagnostic tools show them); the head unit has no
 * text database for them, so look them up by code + control unit.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { fitText } = require('./kit/text-layout');
const { diagnosticText } = require('./diagnostic-text');
const { t: translateUI, plural } = require('./kit/i18n');
const { Diag, parseDtcReply, statusInfo, hex, NRC } = require('./kit/diag');
const DEMO = require('./demo');
const FC = require('./fault_context');
const { Timing, wrap: timeDiag, demoView } = require('./timing');

const W = 1600, H = 520, PER_PAGE = 6;
const GO = '#2fd27a';

// diagnostic addresses -> control unit (unknown ones show as "ECU 0x..")
const { ECU } = require('./kit/ecus');
const { qrLogSheet } = require('./kit/qrlog');
// Fault texts, first match wins:
//  1. dtc_texts.js   this car's own coding tool export (kit/tools/dtc_texts.py; not in git)
//  2. known_texts.js a few hand-written ones (in git)
//  3. dtc_db/        a fault text database imported with kit/tools/dtc_texts.py --db (not in git: it is
//                    BMW's). Each unit's SGBD index (UDS 22 F1 50, what BMW's diagnostic tools identify it by)
//                    picks its texts: sgbd_index.json "<address> <index>" -> texts/<SGBD>.json;
//                    dtc_texts.json there holds "<address>:<code>" ones; unit_names.json names the unit.
//  4. dtc_db/code_texts.json  a fault code list (kit/tools/dtc_texts.py --codes) for faults with no
//                    text above: "<code>": text (any unit) or { "<address>": text } (those units only).
//  5. dtc_db/tables/ fault text tables (kit/tools/dtc_tables.py; BMW's, not in git), split so only the
//                    units that report faults are read: variant/<sgbd>.json the text for exactly that
//                    unit type, addr/<address>.json the text all types at that address agree on (both
//                    before 3.), codes.json code-only texts and ambiguous.json "<code>": how many
//                    different texts a code has (when nothing else knows it).
// The build packs dtc_db/ into one compressed file, dtc_db.pack (kit/runtime/pack.js): ~19 MB of
// texts take ~3.5 MB, and a lookup inflates only the few KB that hold its code.
const DB = require('./kit/pack').open(path.join(__dirname, 'dtc_db'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const req = (m) => { try { return require(m); } catch (e) { return {}; } };
const OWN = Object.assign({}, req('./known_texts'), req('./dtc_texts'));
const text = (key) => OWN[key] || DB.get('dtc_texts.json', key);
const SGBD = DB.json('sgbd_index.json');
const UNIT_NAMES = DB.json('unit_names.json');
const HAS_DB = Object.keys(SGBD).length > 0;
let ids = {};                     // "12" -> "0F26E8" (unit's SGBD index); '' = asked, gave none
const variant = (a) => {
    const v = ids[hex(a)] ? SGBD[hex(a) + ' ' + ids[hex(a)]] : null;
    return v && /^[A-Za-z0-9_]+$/.test(v) ? v : null;
};
// Normalize legacy German names, but preserve Unicode from translated/OEM text.
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[\x00-\x1f\x7f]/g, '');
// a summary where the texts for a unit family differ in wording but agree on the fault
// (not an exact BMW text)
const FAMILY = {
    '23:D1C604': 'Assist sensors: Unexpected Ethernet communication/link',
    '61:03178A': 'Telematics: Mobile network connection limited',
};
function describe(addr, rawCode) {
    const code = String(rawCode).trim().toUpperCase().replace(/^0X/, '').padStart(6, '0');
    const key = hex(addr) + ':' + code;
    const own = text(key);
    if (own) return ascii(own);
    const v = variant(addr);
    // exactly this unit type's text, else the one all unit types at this address agree on
    const iv = (v && DB.get('tables/variant/' + v.toLowerCase() + '.json', code)) || DB.get('tables/addr/' + hex(addr) + '.json', code);
    if (iv) return ascii(iv);
    const t = (v && DB.get('texts/' + v + '.json', code)) || text('*:' + code);   // "*:<code>": any unit
    if (t) return ascii(t);
    const c = DB.get('code_texts.json', code);
    const ct = (typeof c === 'string' ? c : c && c[hex(addr)]) || DB.get('tables/codes.json', code) || FAMILY[key];
    if (ct) return ascii(ct);
    // several different texts and the unit type unknown: say so rather than guess
    const n = DB.get('tables/ambiguous.json', code);
    return n > 0 ? n + ' possible texts (depends on unit type)' : null;
}
// a unit the database identified is named by what it is (same on every model); else the address table
const ecuName = (a) => {
    const v = variant(a);
    return (v && UNIT_NAMES[v] && ascii(UNIT_NAMES[v])) || ECU[a] || v || ('ECU 0x' + hex(a));
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // nothing on the car's buses while nobody is on the page: the diagnostic link is opened when the page is first
        // shown, the Check Control watches run only while it shows (watching the cluster's interface disturbed
        // another app), and a scan left half way stops after the request under way
        let diag = null, diagReady = null, away = true;
        const timing = new Timing();
        const getDiag = () => diagReady || (diagReady = new Diag(ctx.signals, log).init().then((d) => { diag = timeDiag(d, timing); changed(); return d; }));

        /* ---------- state ---------- */
        const FILE = path.join(ctx.dataDir, 'last_scan.json');
        let scan = null;              // { at, demo, ecus: [{ addr, dtcs: [{code,status,mem}], nrc }] }
        try { scan = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* none yet */ }
        // the scan before the last one, to say what is new and what has gone since (a demo scan only against a demo one)
        const PREV = path.join(ctx.dataDir, 'prev_scan.json');
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(PREV, 'utf8')); } catch (e) { /* none yet */ }
        let demoPrev = null, demoScans = 0;
        const fkey = (addr, d) => addr + ':' + String(d.code).toUpperCase() + ':' + (d.mem || 'fault');
        /**
         * What changed since the scan before: { at, fresh: Set of keys, gone: [{ addr, code, status, mem }] }, or null when
         * there is no scan before of the same kind. Only units that answered both times count: a unit that was silent
         * before has no "new" faults, and one silent now has none "gone".
         */
        function compare() {
            const before = scan && scan.demo ? demoPrev : prev;
            if (!scan || !before || !!before.demo !== !!scan.demo) return null;
            const both = new Set(before.ecus.map((e) => e.addr).filter((a) => scan.ecus.some((e) => e.addr === a)));
            const was = new Set(), now = new Set(), gone = [];
            before.ecus.forEach((e) => e.dtcs.forEach((d) => was.add(fkey(e.addr, d))));
            scan.ecus.forEach((e) => e.dtcs.forEach((d) => now.add(fkey(e.addr, d))));
            const fresh = new Set();
            scan.ecus.forEach((e) => { if (both.has(e.addr)) e.dtcs.forEach((d) => { if (!was.has(fkey(e.addr, d))) fresh.add(fkey(e.addr, d)); }); });
            before.ecus.forEach((e) => { if (both.has(e.addr)) e.dtcs.forEach((d) => { if (!now.has(fkey(e.addr, d))) gone.push(Object.assign({ addr: e.addr }, d)); }); });
            return { at: before.at, fresh, gone };
        }
        let diffCache = null, diffFor = null;
        const diff = () => { if (diffFor !== scan) { diffFor = scan; diffCache = compare(); } return diffCache; };
        const isNew = (d) => { const c = diff(); return !!(c && c.fresh.has(fkey(d.addr, d))); };
        const IDS = path.join(ctx.dataDir, 'ecu_ids.json');
        ids = readJson(IDS);
        let phase = 'idle', msg = '', replies = 0, busy = false, version = 0;
        const changed = () => { version++; loop && loop.kick(); };
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !(diag && diag.available));

        /* ---------- Check Control ---------- */
        const cc = new Map();          // ccmId -> { ecu, reason }
        const ccNames = new Map();     // id -> { name, color }
        const walk = (o, fn) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
            fn(o);
            Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], fn); });
        };
        const names = (v) => walk(v, (o) => {
            const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier;
            const nm = o.cCShortName || o.cCName;
            if (id !== undefined && nm) { ccNames.set(id, { name: String(nm), color: o.cCColor }); changed(); }
        });
        // for the health report: the 12 V charge (%), oil and coolant (deg C), the service items { name, colour, way, date }
        const health = { soc12: null, oil: null, coolant: null, service: null };
        const CBS_COLOURS = { DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 };
        const findKey = (v, key) => {
            if (!v || typeof v !== 'object') return null;
            if (key in v) return v;
            for (const k of Object.keys(v)) { const r = findKey(v[k], key); if (r) return r; }
            return null;
        };
        const plain = (x) => String(x === undefined || x === null ? '' : x).replace(/[\x00-\x1f\x7f]/g, '').trim();
        const cbs = (v) => {
            const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
            health.service = arr.map((e) => {
                const it = findKey(e, 'cBSIdentifier') || {}, c = it.cBSColor;
                return { id: it.cBSIdentifier, name: plain(it.cBSServcieName || it.cBSServiceName), colour: typeof c === 'number' ? c : CBS_COLOURS[String(c)] || 0,
                    way: plain(it.cBSServiceWay), date: plain(it.cBSServiceDate) };
            }).filter((e) => e.id !== undefined && e.name);
        };
        const cds = {
            statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (typeof c === 'number' && c >= 0 && c <= 100) health.soc12 = c; },
            statusEngineTemperature: (v) => {
                const o = v && v.temperatureEngineOilDrive, c = v && v.temperatureEngineDrive;
                if (typeof o === 'number' && o !== 255) health.oil = o - 48;
                if (typeof c === 'number' && c !== 255) health.coolant = c - 48;
            },
        };
        let subs = null;
        /** The Check Control watches on (the page showing) or shut down (it isn't). */
        function listen(on) {
            if (on && !subs) {
                cc.clear();                     // (what went out while away wasn't heard: the list is read afresh)
                subs = Promise.all([
                    ctx.signals.watch('de.bmw.infotainment.checkcontrol.CheckControlMaster', '1', {
                        basicList: (v) => walk(v, (o) => {
                            if (o.ccmId === undefined) return;
                            const act = o.activeState === 'AKTIV' || o.activeState === 0;
                            if (act) cc.set(o.ccmId, { ecu: o.requestorDiagAddr, reason: String(o.reason) }); else cc.delete(o.ccmId);
                            changed();
                        }),
                    }, log),
                    ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', { ccList: names, newCCMessage: names, cbsDataServiceList: cbs }, log),
                    ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', cds, log),
                ]);
                log.info('page shown: Check Control watched');
            } else if (!on && subs) {
                const s = subs; subs = null;
                s.then((l) => Promise.all(l.map((w) => w && w.shutdown && w.shutdown()))).catch(() => {});
                log.info('page left: Check Control watches shut down');
            }
        }

        /* ---------- scan / clear ---------- */
        async function doScan() {
            if (busy) return;
            busy = true; phase = 'scanning'; replies = 0; msg = ''; changed();
            ui.text('BTN_SCAN', 'Scanning...');
            try {
                await getDiag();
                if (useDemo()) {
                    for (let i = 1; i <= DEMO.ecus.length; i++) { await new Promise((r) => setTimeout(r, 180)); replies = i; changed(); }
                    if (scan && scan.demo) demoPrev = scan;
                    scan = { at: Date.now(), demo: true, ecus: JSON.parse(JSON.stringify(DEMO.ecus)) };
                    if (++demoScans % 2 === 0) { const e = scan.ecus.find((x) => x.dtcs.length > 1); if (e) e.dtcs.pop(); }
                } else {
                    const mask = settings.get('scope') === 'all' ? 0xFF : 0x0C;
                    const byEcu = new Map();
                    const read = async (params, mem) => {
                        const res = await diag.functional(0x19, params, { onReply: (e, n) => { replies = Math.max(replies, n); changed(); } });
                        res.forEach((uds, addr) => {
                            const p = parseDtcReply(uds, params);
                            const e = byEcu.get(addr) || { addr, dtcs: [], nrc: null };
                            p.dtcs.forEach((d) => e.dtcs.push({ code: d.code, status: d.status, mem }));
                            if (!p.ok && mem === 'fault') e.nrc = p.nrc;
                            byEcu.set(addr, e);
                        });
                    };
                    await read([0x02, mask], 'fault');
                    // the info memory is extra: if it can't be read, keep the fault memory scan
                    let infoFailed = false;
                    if (settings.get('info') && !away) {
                        msg = 'Reading info memory...'; changed();
                        try { await read([0x17, mask, 0x01], 'info'); } catch (e) { infoFailed = true; log.warn('info memory: ' + e); }
                    }
                    if (scan && !scan.demo) {
                        prev = scan;
                        try { fs.writeFileSync(PREV, JSON.stringify(prev)); } catch (e) { log.warn('save previous scan: ' + e); }
                    }
                    scan = { at: Date.now(), demo: false, ecus: Array.from(byEcu.values()), infoFailed };
                    try { fs.writeFileSync(FILE, JSON.stringify(scan)); } catch (e) { log.warn('save scan: ' + e); }
                    if (!away) await identify(scan.ecus.map((e) => e.addr));
                    else log.info('scan: page left, info memory and unit names skipped');
                }
                scan.ecus.sort((a, b) => b.dtcs.length - a.dtcs.length || a.addr - b.addr);
                const n = scan.ecus.reduce((s, e) => s + e.dtcs.length, 0);
                const c = diff();
                log.info('scan: ' + scan.ecus.length + ' control units, ' + n + ' faults' + (c ? ', ' + c.fresh.size + ' new and ' + c.gone.length + ' gone since ' + when(c.at) : ''));
                msg = !scan.ecus.length ? 'No control unit answered - ignition on?' : scan.infoFailed ? 'Info memory not read this time (unit busy) - scan again for it' : '';
                phase = 'done';
            } catch (e) {
                log.warn('scan failed: ' + e);
                phase = 'error'; msg = 'Scan failed: ' + e.message;
            }
            busy = false; page = 0;
            ui.text('BTN_SCAN', 'Scan again');
            changed();
        }

        /**
         * Ask every unit that answered the scan for its SGBD index once (22 F1 50), so the database can
         * give its faults a text and the unit its name; kept in data/ecu_ids.json (also the list of this
         * car's unit types). Read-only; a unit that refuses is not asked again, one that stays silent is.
         */
        async function identify(addrs) {
            const todo = HAS_DB ? addrs.filter((a) => ids[hex(a)] === undefined) : [];
            if (!todo.length) return;
            let i = 0;
            for (const a of todo) {
                if (away) break;
                msg = 'Identifying control units... ' + (++i) + '/' + todo.length; changed();
                try {
                    const r = await diag.physical(a, 0x22, [0xF1, 0x50], 3000,
                        (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22));
                    if (!r) { log.info('unit ' + hex(a) + ': no answer to 22 F1 50 (asked again next scan)'); continue; }
                    ids[hex(a)] = r[0] === 0x62 && r.length >= 6 ? hex(((r[3] << 16) | (r[4] << 8) | r[5]) >>> 0, 6) : '';
                    log.info('unit ' + hex(a) + ': SGBD index ' + (ids[hex(a)] || 'none') + (variant(a) ? ' -> ' + variant(a) : ''));
                } catch (e) { log.warn('identify ' + hex(a) + ': ' + e); }
            }
            try { fs.writeFileSync(IDS, JSON.stringify(ids)); } catch (e) { log.warn('save ids: ' + e); }
            msg = '';
        }

        /**
         * Clear one unit's fault memory (14 FF FF FF), its replies only (other apps may talk to it too). No
         * answer: asked once more. Refused for its session or conditions (engine and e-motor units: 7F 14 22,
         * 7E, 7F, 31, 33): asked again in the extended session (10 03), then back to the default one (10 01).
         * Resolves with { ok, why } (why: the refusal, for the page and the log).
         */
        const RETRY_NRC = [0x22, 0x31, 0x33, 0x7E, 0x7F];
        async function clearUnit(addr) {
            const ask = () => diag.physical(addr, 0x14, [0xFF, 0xFF, 0xFF], 8000, (u) => u[0] === 0x54 || (u[0] === 0x7F && u[1] === 0x14));
            const session = (n) => diag.physical(addr, 0x10, [n], 3000, (u) => (u[0] === 0x50 && u[1] === n) || (u[0] === 0x7F && u[1] === 0x10));
            let r = await ask();
            if (!r) r = await ask();
            if (r && r[0] === 0x7F && RETRY_NRC.indexOf(r[2]) >= 0) {
                const first = r;
                const ext = await session(0x03);
                if (ext && ext[0] === 0x50) {
                    r = (await ask()) || first;
                    await session(0x01);
                }
                log.info('clear ' + hex(addr) + ': refused (' + (NRC[first[2]] || hex(first[2])) + ') - extended session: ' + (ext ? (ext[0] === 0x50 ? 'yes' : 'refused') : 'no answer') + ', then ' + (r[0] === 0x54 ? 'cleared' : 'still refused'));
            }
            if (r && r[0] === 0x54) return { ok: true };
            const why = !r ? 'no answer' : r[0] === 0x7F ? (r[2] === 0x22 ? 'refused now (engine on? ignition only)' : NRC[r[2]] || 'NRC ' + hex(r[2])) : 'reply ' + r.map((x) => hex(x)).join('');
            log.warn('clear ' + hex(addr) + ': ' + why);
            return { ok: false, why };
        }

        let clearArmed = null;
        const clearLabel = () => { changed(); return ui.text('BTN_CLEAR', clearArmed ? 'Yes, clear' : 'Clear all'); };
        async function doClear() {
            if (busy) return;
            const targets = scan ? scan.ecus.filter((e) => e.dtcs.some((d) => d.mem === 'fault')) : [];
            if (!targets.length) { msg = scan ? 'Nothing to clear' : 'Scan first, then clear'; changed(); return; }
            if (!clearArmed) {
                clearArmed = setTimeout(() => { clearArmed = null; clearLabel(); }, 5000);
                msg = 'Clears ' + targets.length + ' ' + plural(targets.length, 'control unit(s) - press again within 5 s', 'control unit(s) - press again within 5 s'); changed();
                return clearLabel();
            }
            clearTimeout(clearArmed); clearArmed = null; clearLabel();
            busy = true; phase = 'clearing'; changed();
            await getDiag();
            let ok = 0;
            const failed = [], cleared = [];
            // first to every unit at once (functional, as the workshop tester clears): the engine, e-motor and brake
            // units refuse the physical request (7F 14 22) with the engine off but take this one
            let all = new Map();
            if (!scan.demo) {
                msg = 'Clearing all control units...'; changed();
                try { all = await diag.functional(0x14, [0xFF, 0xFF, 0xFF], { idleMs: 5000 }); } catch (err) { log.warn('clear all: ' + err); }
                log.info('clear all: ' + Array.from(all.values()).filter((u) => u[0] === 0x54).length + ' units cleared');
            }
            for (const e of targets) {
                const r = all.get(e.addr);
                if (r && r[0] === 0x54) { ok++; cleared.push(e.addr); continue; }
                msg = 'Clearing ' + ecuName(e.addr) + '...'; changed();
                if (scan.demo) { await new Promise((r) => setTimeout(r, 400)); ok++; cleared.push(e.addr); continue; }
                try {
                    const res = await clearUnit(e.addr);
                    if (res.ok) { ok++; cleared.push(e.addr); } else failed.push(ecuName(e.addr) + ': ' + res.why);
                } catch (err) { log.warn('clear ' + hex(e.addr) + ': ' + err); failed.push(ecuName(e.addr) + ': ' + (err.message || err)); }
            }
            log.info('cleared ' + ok + '/' + targets.length + (failed.length ? ' - not: ' + failed.join('; ') : ''));
            if (scan.demo) DEMO.ecus.forEach((e) => { e.dtcs = e.dtcs.filter((d) => d.mem !== 'fault' || (d.status & 1)); });
            busy = false;
            msg = 'Cleared ' + ok + ' of ' + targets.length + ' ' + plural(targets.length, 'control unit(s) - scanning again', 'control unit(s) - scanning again');
            changed();
            await new Promise((r) => setTimeout(r, 1500));
            const keep = msg;
            await doScan();
            // what the clear left: units that refused, and faults back at once (still present: the cause is still there)
            const back = scan && !scan.demo ? scan.ecus.filter((e) => cleared.indexOf(e.addr) >= 0 && e.dtcs.some((d) => d.mem === 'fault')).map((e) => ecuName(e.addr)) : [];
            if (back.length) log.info('faults back at once after the clear: ' + back.join(', '));
            if (!msg) {
                msg = failed.length ? 'Not cleared - ' + failed.join(';  ')
                    : back.length ? 'Cleared; back at once (still present): ' + back.join(', ')
                        : keep.replace(' - scanning again', '');
            }
            changed();
        }

        /* ---------- fault details ---------- */
        // the fault opened: { addr, code, mem, status, phase: 'reading' | 'done' | 'error', ctx, msg, step }
        let detail = null, rawOpen = false;
        async function openDetail(d) {
            if (!d || busy) return;
            const mine = { addr: d.addr, code: d.code, mem: d.mem, status: d.status, phase: 'reading', ctx: null, msg: '', step: 0 };
            detail = mine; rawOpen = false; changed();
            try {
                if (scan && scan.demo) {
                    await new Promise((r) => setTimeout(r, 400));
                    mine.ctx = FC.demoContext(d.code, d.status);
                } else {
                    await getDiag();
                    mine.ctx = await FC.readContext(diag, d.addr, d.code, { onStep: (n) => { mine.step = n; changed(); } });
                    log.info('fault ' + d.code + ' at ' + hex(d.addr) + ': ' + mine.ctx.snapshots.length + ' snapshot(s), ' + mine.ctx.extended.length
                        + ' extended record(s), ' + mine.ctx.requests + ' requests' + (mine.ctx.noAnswer ? ', no answer' : ''));
                }
                rawLines(mine.ctx).forEach((v) => log.info('  ' + d.code + ' ' + v.head + ': ' + v.body));
                mine.phase = 'done';
            } catch (e) {
                log.warn('fault details: ' + e);
                mine.phase = 'error'; mine.msg = String(e.message || e);
            }
            changed();
        }
        const closeDetail = () => { detail = null; changed(); };
        /** what the unit stored, one line per value: { head, body } (shown raw; no table names them) */
        function rawLines(c) {
            const out = [];
            if (!c) return out;
            c.snapshots.forEach((sn) => {
                sn.values.forEach((v) => out.push({ head: 'Snapshot ' + sn.rec + ', value 0x' + hex(v.did, 4), body: v.bytes ? FC.rawText(v.bytes) : 'length not known' }));
                if (sn.rest) out.push({ head: 'Snapshot ' + sn.rec + ', ' + (sn.count - 1) + ' more value' + (sn.count === 2 ? '' : 's') + ' together', body: FC.rawText(sn.rest) });
            });
            c.extended.forEach((e) => out.push({ head: 'Extra record ' + hex(e.rec), body: FC.rawText(e.bytes) }));
            return out;
        }
        /** Fault details on the next fault (the first of the page shown when none is open). */
        function nextDetail() {
            const l = listed();
            if (!l.length) { msg = scan ? 'No faults to show' : 'Scan first'; changed(); return; }
            const i = detail ? l.findIndex((d) => d.addr === detail.addr && d.code === detail.code && d.mem === detail.mem) : -1;
            const first = scrolls ? 0 : Math.min(page, Math.max(0, pageCount() - 4)) * perPage;     // (fault pages: pageCount() - 3)
            openDetail(i >= 0 ? l[(i + 1) % l.length] : l[Math.min(first, l.length - 1)]);
        }

        /* ---------- drawing ---------- */
        let page = 0;
        let perPage = PER_PAGE;          // faults on a page: one more where the screen has room below the page (render)
        let scrolls = false;             // where the kit runs the screen: one Faults page, each list scrolled (render)
        let gliding = false;             // a list still gliding to where it was scrolled: draw the next frame too
        const scroll = { faults: { y: 0, max: 0 }, cc: { y: 0, max: 0 }, ecus: { y: 0, max: 0 } };
        let only = null;                 // a control unit tapped on the Control units page: the Faults page lists its faults alone
        const faults = () => (scan ? [].concat(...scan.ecus.map((e) => e.dtcs.map((d) => Object.assign({ addr: e.addr }, d)))) : []);
        const listed = () => (only === null ? faults() : faults().filter((d) => d.addr === only));
        /**
         * The last scan as plain text, for Settings > Faults as QR: a phone camera reads the codes as they are, so the
         * list can go to a workshop or a forum without SSH or a decoder. Each unit that answered with faults, then its
         * faults (code, status, text where known). No VIN: the scan doesn't hold one.
         */
        function faultText() {
            if (!scan) return 'Fault Scanner: no scan yet';
            const p = (n) => String(n).padStart(2, '0'), d = new Date(scan.at);
            const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
            const all = faults(), units = scan.ecus.filter((e) => e.dtcs.length).sort((a, b) => a.addr - b.addr);
            const out = ['Scan ' + date + (scan.demo ? ' (demo data)' : ''),     // (the code's header names the app and version)
                all.length + ' faults in ' + units.length + ' units, ' + scan.ecus.length + ' units answered'];
            units.forEach((e) => {
                out.push('', ecuName(e.addr) + ' (0x' + hex(e.addr) + ')');
                e.dtcs.forEach((f) => {
                    const desc = describe(e.addr, f.code);
                    out.push(f.code + ' ' + statusInfo(f.status).label + (f.mem === 'info' ? ' INFO' : '') + (isNew(Object.assign({ addr: e.addr }, f)) ? ' NEW' : '') + (desc ? ' ' + desc : ''));
                });
            });
            const c = diff();
            if (c && c.gone.length) {
                out.push('', 'Gone since the scan of ' + when(c.at));
                c.gone.forEach((g) => out.push(ecuName(g.addr) + ' (0x' + hex(g.addr) + '): ' + g.code + (g.mem === 'info' ? ' INFO' : '')));
            }
            return out.join('\n');
        }
        /** The health report's head: everything but the fault list, which follows it (faultText). */
        function healthText() {
            const demo = !!(scan && scan.demo), p = (n) => String(n).padStart(2, '0'), d = new Date();
            const out = ['Health report ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + (demo ? ' (demo data)' : '')];
            const f = faults(), fm = f.filter((x) => x.mem === 'fault'), active = fm.filter((x) => x.status & 1).length, c = diff();
            out.push(!scan ? 'Faults: no scan yet' : 'Faults: ' + fm.length + ' stored, ' + active + ' active, in ' + scan.ecus.filter((e) => e.dtcs.length).length + ' of '
                + scan.ecus.length + ' units (scan ' + when(scan.at) + ')' + (c ? ', ' + c.fresh.size + ' new and ' + c.gone.length + ' gone since ' + when(c.at) : ''));
            const ccl = ccList();
            out.push('Check Control: ' + (ccl.length ? ccl.map((m) => m.name || 'message ' + m.id).join(', ') : 'none'));
            const h = demo ? { soc12: 84, oil: 96, coolant: 91, service: [{ name: 'Engine oil', colour: 3, way: '12 300 km', date: '09/2027' }, { name: 'Brake fluid', colour: 2, way: '', date: '03/2027' }] } : health;
            out.push('12 V battery: ' + (h.soc12 === null ? 'not sent yet' : h.soc12 + ' % charged'));
            out.push('Engine: oil ' + (h.oil === null ? '--' : Math.round(h.oil) + ' C') + ', coolant ' + (h.coolant === null ? '--' : Math.round(h.coolant) + ' C'));
            if (!h.service) out.push('Service: not sent yet');
            else {
                out.push('Service:');
                const st = ['', 'due now', 'due soon', 'OK', 'due soon'];
                h.service.forEach((i) => out.push('  ' + i.name + ': ' + (st[i.colour] || '-') + [i.way, i.date].filter(Boolean).map((x) => ', ' + x).join('')));
            }
            return out.join('\n') + '\n\n' + faultText();
        }
        if (ctx.settingsRow) {
            ctx.settingsRow({
                label: 'Health report as QR', value: 'Faults, battery, engine and service, for a phone camera',
                open: () => qrLogSheet({ title: 'Health report', plain: true, text: healthText, app: 'Fault Scanner', version: ctx.spec.version,
                    help: ['A car report to share: open the', 'Fault Scanner page for a minute first,', 'so the car has sent its values.'] }),
            });
        }
        if (ctx.settingsRow) {
            ctx.settingsRow({
                label: 'Faults as QR', value: 'The last scan, for a phone camera',
                open: () => qrLogSheet({ title: 'Faults as QR', plain: true, text: faultText, app: 'Fault Scanner', version: ctx.spec.version,
                    help: ['Point the phone camera at the code:', 'it reads as plain text, no app needed.', 'Several pages: one photo each.'] }),
            });
        }
        const pageCount = () => (scrolls ? 1 : Math.max(1, Math.ceil(listed().length / perPage))) + 3;
        const shownList = () => { const fp = pageCount() - 3; return page < fp ? scroll.faults : page === fp ? scroll.cc : scroll.ecus; };
        // a finger dragged on the page or the controller turned on it (cv.scroll): the list shown moves
        ctx.onScroll((dy) => {
            const s = shownList(), y = G.clamp(s.y + dy, 0, s.max), moved = y !== s.y;
            s.y = y;
            if (moved) changed();
            return moved;
        });
        const showOnly = (addr) => { only = addr; page = 0; scroll.faults.y = 0; changed(); };
        const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
        const ccList = () => (scan && scan.demo ? DEMO.cc : Array.from(cc.entries()).map(([id, m]) => Object.assign({ id }, m, ccNames.get(id) || {})));

        /** txt cut with "..." to at most max px wide */
        function fit(cv, txt, size, max, opt) {
            return fitText(cv, txt, size, max, opt);
        }

        /** Tile i of the four across the top: 16 apart, the last one ending where the list's panel does (1576). */
        function tile(cv, t, i, label, value, sub, col) {
            const w = (1552 - 3 * 16) / 4, x = 24 + i * (w + 16);
            G.panel(cv, t, x, 44, w, 115, label);
            cv.text(value, x + 18, 142, 64, col, { font: 'num' });
            if (sub) cv.text(sub, x + w - 18, 142, 22, t.dim, { align: 'right' });
        }

        /** G20-style frame: tab bar with the page names along the top (fault pages share one tab). */
        function header(cv, t) {
            const fp = pageCount() - 3, sel = page < fp ? 0 : page - fp + 1;
            G.frame(cv, t, ['Faults' + (fp > 1 ? '  ' + (Math.min(page, fp - 1) + 1) + '/' + fp : ''), 'Check Control', 'Control units', 'Response times'], sel,
                [(scan && scan.demo || (!scan && useDemo())) && { text: 'DEMO' }]);
        }

        function tiles(cv, t) {
            const f = faults(), active = f.filter((d) => d.status & 1).length, n = scan ? scan.ecus.length : null;
            const fm = f.filter((d) => d.mem === 'fault').length, im = f.length - fm;
            tile(cv, t, 0, 'Control units', phase === 'scanning' ? String(replies) : n === null ? '--' : String(n), phase === 'scanning' ? 'answering...' : 'answered', t.text);
            tile(cv, t, 1, 'Faults', scan ? String(fm) : '--', im ? '+ ' + im + ' info' : 'stored', !scan ? t.dim : fm ? t.warn : GO);
            tile(cv, t, 2, 'Active now', scan ? String(active) : '--', 'present right now', !scan ? t.dim : active ? t.crit : GO);
            const c = ccList().length;
            tile(cv, t, 3, 'Check Control', String(c), plural(c, 'messages', 'messages'), c ? t.warn : GO);
        }

        function listPanel(cv, t, title, buttons) {
            const p = G.panel(cv, t, 24, 176, 1552, 336, title);
            // the page's buttons right after its title, centred on it (where the kit runs the screen; else the bar's)
            let bx = 42 + cv.textWidth(String(title), 26, { font: 'bold' }) + 28;
            (buttons || []).forEach((b) => { bx += G.button(cv, t, bx, 189, 0, 40, b.label, b.run, b) + 12; });
            let right = msg;
            if (!right && scan) {
                const c = diff();
                right = 'Last scan ' + when(scan.at) + (c && (c.fresh.size || c.gone.length) ? ', since ' + when(c.at) + ': ' + c.fresh.size + ' new, ' + c.gone.length + ' gone'
                    : c ? ', nothing changed since ' + when(c.at) : '');
            }
            if (phase === 'scanning' || phase === 'clearing') {
                const w = 300, x = 1552 - w, f = ((Date.now() / 1200) % 1);
                cv.roundRect(x, 195, w, 8, 4, t.track);
                cv.roundRect(x + f * (w - 80), 195, 80, 8, 4, t.accent);
                if (!msg) right = phase === 'scanning' ? 'Asking every control unit...' : '';
                cv.text(right, x - 20, 212, 22, t.text, { align: 'right' });
            } else if (right) {
                // (cut to the room the title and its buttons leave; the log has it whole)
                cv.text(fit(cv, right, 22, Math.max(240, 1552 - bx - 24)), 1552, 212, 22, phase === 'error' || /^Not cleared/.test(right) ? t.crit : t.dim, { align: 'right' });
            }
            return p;
        }

        /**
         * A list in panel p scrolled by s (scroll.<list>): its content from y top (unscrolled) to `bottom` px
         * further down, cut to the panel from y clipTop. draw(sy, from, to) draws it moved up by sy, the rows
         * between from and to only. Where nothing scrolls (no renderer to run the screen) the list draws as it
         * is: paged.
         */
        function scrolled(cv, t, p, s, key, clipTop, top, bottom, draw) {
            if (!scrolls) { draw(0); return; }
            const end = p.y + p.h - 12;                  // the list's last row ends 12 over the panel's bottom
            s.max = Math.max(0, top + bottom - end);
            s.y = G.clamp(s.y, 0, s.max);
            const sy = G.smooth('dtcScroll:' + key, s.y, 22);
            if (sy !== s.y) gliding = true;
            cv.clip(p.x, clipTop, p.w, p.y + p.h - 4 - clipTop);
            draw(sy, clipTop, p.y + p.h - 4);
            cv.noclip();
            if (!s.max) return;
            // where the list is: a bar at the panel's right edge
            const vis = end - clipTop, bh = Math.max(40, vis * vis / (vis + s.max));
            const bar = { x: p.x + p.w - 11, y: clipTop + (vis - bh) * sy / s.max, w: 6, h: bh };
            cv.roundRect(bar.x, bar.y, bar.w, bar.h, 3, withAlpha(t.text, 0.3));
            // the controller: the title's buttons first, then the list (its bar red while it is on it)
            cv.scroll = { y: clipTop, bar };
        }

        function drawFaults(cv, t) {
            const f = listed(), pages = scrolls ? 1 : Math.max(1, Math.ceil(f.length / perPage));
            const busy = phase === 'scanning' || phase === 'clearing';
            const p = listPanel(cv, t, (only === null ? 'Faults' : 'Faults  ' + ecuName(only)) + (pages > 1 ? '  ' + (page + 1) + '/' + pages : ''), [
                { label: phase === 'scanning' ? 'Scanning...' : scan ? 'Scan again' : 'Scan now', run: () => doScan(), key: 'scan', busy },
                { label: clearArmed ? 'Yes, clear' : 'Clear all', run: () => doClear(), key: 'clear', busy: busy || !faults().length, color: clearArmed ? t.crit : null },
                only !== null && { label: 'All units', run: () => showOnly(null), key: 'all' },
            ].filter(Boolean));
            const mid = Math.round((p.y + p.h - G.BOTTOM) / 2);     // the messages stay centred in a taller panel
            if (!scan) {
                cv.text(phase === 'scanning' ? 'Scanning...' : 'Press "Scan now" (ignition on)', 800, 369 + mid, 32, t.dim, { align: 'center' });
                return;
            }
            if (!f.length && phase !== 'scanning') {
                cv.circle(800, 327 + mid, 40, withAlpha(GO, 0.2));
                cv.polyline([[782, 327 + mid], [796, 342 + mid], [820, 312 + mid]], 7, GO);     // check mark ('✓' isn't in the baked fonts)
                cv.text(scan.ecus.length ? 'No faults stored' : 'No answer', 800, 433 + mid, 32, t.text, { align: 'center', font: 'bold' });
                return;
            }
            const rows = scrolls ? f : f.slice(page * perPage, page * perPage + perPage);
            scrolled(cv, t, p, scroll.faults, 'faults', 233, 239, rows.length * 46 - 12, (sy, from, to) => rows.forEach((d, i) => {
                const y = 239 + i * 46 - sy;    // (room under the title's buttons: 10 px, as over them)
                if (y + 41 < from || y > to) return;
                const s = statusInfo(d.status), col = t[s.sev] || t.dim;
                if (isNew(d)) cv.roundRect(36, y, 6, 34, 3, t.warn);            // new since the scan before
                cv.roundRect(48, y, 170, 34, 6, withAlpha(col, 0.22));
                cv.text(s.label, 133, y + 25, 20, col, { align: 'center', font: 'bold', spacing: 0.5 });
                cv.text(d.code, 246, y + 28, 32, t.text, { font: 'bold', spacing: 1 });
                cv.text(fit(cv, ecuName(d.addr), 26, 680 - 420 - 16), 420, y + 27, 26, t.text);
                // the fault's text when known (cut to fit)
                const desc = describe(d.addr, d.code);
                const txt = desc ? (d.mem === 'info' ? translateUI('INFO: ') : '') + diagnosticText(desc) : d.mem === 'info' ? translateUI('INFO MEMORY') : '';
                // Resolve diagnosis before layout; never reapply UI word substitution.
                const diagnosticOptions = { literal: true };
                if (txt) cv.text(fit(cv, txt, 22, 1552 - 680, diagnosticOptions), 680, y + 27, 22, t.dim, diagnosticOptions);
                if (i < rows.length - 1) cv.fillRect(48, y + 40, 1504, 1, withAlpha(t.tick, 0.25));
                const ty = Math.max(y, from || 0), th = Math.min(y + 40, to || 9999) - ty;
                if (cv.own && th >= 20) cv.target(48, ty, 1504, th, () => openDetail(d), 'fault' + d.addr + d.code + d.mem, 6);
            }));
        }

        function drawCC(cv, t) {
            const p = listPanel(cv, t, 'Check Control messages'), dy = p.y + p.h - G.BOTTOM;
            const l = ccList();
            if (!l.length) { cv.text('No active Check Control messages', 800, 369 + Math.round(dy / 2), 30, t.dim, { align: 'center' }); return; }
            const COL = { RED: t.crit, YELLOW: t.warn, ORANGE: t.warn, GREEN: GO, WHITE: t.text };
            const rows = scrolls ? l : l.slice(0, perPage);
            scrolled(cv, t, p, scroll.cc, 'cc', 229, 231, rows.length * 47 - 7, (sy, from, to) => rows.forEach((m, i) => {
                const y = 231 + i * 47 - sy;
                if (y + 41 < from || y > to) return;
                cv.circle(66, y + 18, 9, COL[m.color] || t.dim);
                cv.text(m.name ? diagnosticText(m.name) : translateUI('Message ') + m.id, 92, y + 27, 28, t.text, { font: 'bold', literal: true });
                if (m.ecu !== undefined) cv.text(fit(cv, ecuName(m.ecu), 22, 420), 1552, y + 27, 22, t.dim, { align: 'right' });
                if (i < rows.length - 1) cv.fillRect(48, y + 40, 1504, 1, withAlpha(t.tick, 0.25));
            }));
            if (l.length > rows.length) cv.text('+ ' + (l.length - rows.length) + ' more', 1552, 506 + dy, 22, t.dim, { align: 'right' });
        }

        function drawEcus(cv, t) {
            const p = listPanel(cv, t, 'Control units that answered'), dy = p.y + p.h - G.BOTTOM;
            const l = scan ? scan.ecus.slice().sort((a, b) => a.addr - b.addr) : [];
            if (!l.length) { cv.text(scan ? 'No control unit answered' : 'Scan first', 800, 369 + Math.round(dy / 2), 30, t.dim, { align: 'center' }); return; }
            const cols = 5, cw = 296, ch = 55;
            // a taller panel: another row of units where one fits whole; the grid stays compact (scrolled: all of them)
            const shown = scrolls ? l : l.slice(0, cols * (5 + Math.floor(dy / ch)));
            scrolled(cv, t, p, scroll.ecus, 'ecus', 229, 233, Math.ceil(shown.length / cols) * ch - 6, (sy, from, to) => shown.forEach((e, i) => {
                const x = 48 + (i % cols) * (cw + 8), y = 233 + Math.floor(i / cols) * ch - sy;
                if (y + ch < from || y > to) return;
                const act = e.dtcs.some((d) => d.status & 1), n = e.dtcs.length;
                const col = act ? t.crit : n ? t.warn : GO;
                cv.roundRect(x, y, cw, ch - 6, 6, withAlpha(col, 0.12));
                cv.fillRect(x, y, 5, ch - 6, col);
                cv.text(fit(cv, ecuName(e.addr), 22, cw - 120, { font: 'bold' }), x + 18, y + (e.nrc ? 23 : 32), 22, t.text, { font: 'bold' });
                if (e.nrc) cv.text(NRC[e.nrc] || 'NRC ' + hex(e.nrc), x + 18, y + 44, 20, t.dim);
                cv.text(n ? n + ' ' + plural(n, 'fault', 'faults') : 'OK', x + cw - 12, y + 32, 22, col, { align: 'right', font: 'bold' });
                // tapped (or pressed with the controller): the Faults page with this unit's faults alone
                // (scrolled: the part of the tile in the panel, if it shows enough of it)
                const ty = Math.max(y, from), th = Math.min(y + ch - 6, to) - ty;
                if (cv.own && th >= 20) cv.target(x, ty, cw, th, () => showOnly(e.addr), 'ecu' + e.addr, 6);
            }));
        }

        /** text cut into lines of at most w px (at most max lines; the last one cut with "...") */
        function wrapLines(cv, txt, size, w, max, opt) {
            const words = String(txt || '').split(/\s+/), lines = [];
            let cur = '';
            words.forEach((wd) => {
                const next = cur ? cur + ' ' + wd : wd;
                if (cur && cv.textWidth(next, size, opt) > w) { lines.push(cur); cur = wd; } else cur = next;
            });
            if (cur) lines.push(cur);
            if (lines.length > max) { lines.length = max; lines[max - 1] = fit(cv, lines[max - 1] + ' ...', size, w, opt); }
            return lines;
        }

        /** Fault details: the fault and its status bits on the left, what the unit stored with it on the right. */
        function drawDetail(cv, t) {
            const dt = detail, s = statusInfo(dt.status), col = t[s.sev] || t.dim;
            const L = G.panel(cv, t, 24, 44, 720, 468, 'Fault ' + dt.code);
            let bx = 42 + cv.textWidth('Fault ' + dt.code, 26, { font: 'bold' }) + 24;
            bx += G.button(cv, t, bx, 57, 0, 40, 'Back', closeDetail, { key: 'back' }) + 12;
            G.button(cv, t, bx, 57, 0, 40, 'Next fault', nextDetail, { key: 'nextfault', busy: dt.phase === 'reading' });
            cv.text(fit(cv, ecuName(dt.addr) + '  (0x' + hex(dt.addr) + ')', 24, 660), 48, 136, 24, t.text, { font: 'bold' });
            const desc = describe(dt.addr, dt.code);
            const dopt = { literal: true };
            wrapLines(cv, desc ? diagnosticText(desc) : 'No text known for this code on this unit type', 20, 660, 2, dopt)
                .forEach((ln, i) => cv.text(ln, 48, 168 + i * 26, 20, desc ? t.dim : withAlpha(t.dim, 0.7), dopt));
            G.pill(cv, t, 48, 214, 200, 32, s.label + (dt.mem === 'info' ? ' INFO' : ''), { color: col, size: 17 });
            cv.text('status byte 0x' + hex(dt.status) + ', as the unit reports it:', 266, 237, 17, t.dim);
            FC.statusBits(dt.status).forEach((b, i) => {
                const y = 262 + i * 30, on = b.on, c = on ? (b.bit === 0x01 || b.bit === 0x80 ? t.crit : b.bit === 0x08 || b.bit === 0x04 ? t.warn : t.accent) : t.dim;
                if (on) cv.circle(60, y + 9, 8, c); else cv.arc(60, y + 9, 6.5, 8, 0, 360, withAlpha(t.dim, 0.6));
                cv.text(b.label, 80, y + 16, 19, on ? t.text : withAlpha(t.dim, 0.8), on ? { font: 'bold' } : undefined);
                cv.text(on ? 'yes' : 'no', L.x + L.w - 24, y + 16, 18, on ? c : withAlpha(t.dim, 0.8), { align: 'right', font: 'bold' });
            });

            const R = G.panel(cv, t, 760, 44, 816, 468, 'Stored with the fault');
            const c = dt.ctx;
            if (dt.phase === 'reading') {
                const w = 360, f = ((Date.now() / 1200) % 1);
                cv.roundRect(784, 140, w, 8, 4, t.track);
                cv.roundRect(784 + f * (w - 80), 140, 80, 8, 4, t.accent);
                cv.text('Asking ' + ecuName(dt.addr) + '... request ' + (dt.step || 1), 784, 186, 22, t.text);
                cv.text('A few requests to this unit alone: which records it keeps, then each one.', 784, 222, 19, t.dim);
                return;
            }
            if (dt.phase === 'error') { cv.text('Could not read: ' + dt.msg, 784, 150, 22, t.crit); return; }
            if (c.noAnswer) {
                cv.text('The unit did not answer (asleep, or busy).', 784, 150, 22, t.text);
                cv.text('Ignition on, then Next fault and back, or Read it again later.', 784, 184, 19, t.dim);
                return;
            }
            const values = rawLines(c);
            const tilesR = [['SNAPSHOTS', c.snapshots.length, 'moments the unit kept'], ['EXTRA RECORDS', c.extended.length, 'counters and the like'],
                ['VALUES NAMED', 0, 'of ' + values.length + ': no table']];
            tilesR.forEach((x, i) => {
                const tx = 784 + i * 262;
                cv.text(x[0], tx, 116, 15, t.dim, { font: 'bold', spacing: 2 });
                cv.text(String(x[1]), tx, 166, 48, i === 2 ? t.dim : t.text, { font: 'num' });
                cv.text(x[2], tx + cv.textWidth(String(x[1]), 48, { font: 'num' }) + 12, 164, 17, t.dim);
            });
            if (!values.length) {
                cv.text('The unit keeps nothing extra with this fault' + (Object.keys(c.refused).length ? ' (it refused the question)' : '') + '.', 784, 226, 21, t.text);
                return;
            }
            let y = 196;
            const ser = FC.series(c.snapshots);
            if (ser.length && !(cv.own && rawOpen)) {     // (raw values open: the room goes to them)
                // one identifier over the snapshots: its numbers as bars, so a change from one to the next shows
                const sr = ser[0], vals = sr.points.map((p) => p.value), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
                const pad = Math.max(1, (hi - lo) * 0.25), step = G.niceStep(hi - lo + 2 * pad, 2);
                const y0 = Math.floor((lo - pad) / step) * step, y1 = Math.ceil((hi + pad) / step) * step;
                cv.text('Value 0x' + hex(sr.did, 4) + ' in each snapshot: raw number, what it measures is not known', 784, y + 12, 17, t.dim);
                const ch = G.chart(cv, t, 776, y + 24, 780, 100, { xMin: sr.points[0].rec, xMax: sr.points[sr.points.length - 1].rec, xStep: 1, yMin: y0, yMax: y1, yStep: step,
                    xFmt: (v) => 'snapshot ' + v, yFmt: (v) => String(Math.round(v)), padLeft: 150, padRight: 90,
                    series: [{ pts: sr.points.map((p) => [p.rec, p.value]), color: t.accent, width: 3 }] });
                sr.points.forEach((p) => {
                    const px = ch.X(p.rec), py = ch.Y(p.value);
                    cv.circle(px, py, 7, t.accent);
                    cv.text(String(p.value), px, py - 12, 16, t.text, { align: 'center', font: 'bold' });
                });
                y += 138;
            }
            if (cv.own) {
                G.button(cv, t, 784, y, 0, 36, rawOpen ? 'Hide raw values' : 'Show raw values (' + values.length + ')', () => { rawOpen = !rawOpen; changed(); }, { key: 'raw' });
                y += 44;
            }
            const rows = cv.own && !rawOpen ? [] : values.slice(0, Math.max(0, Math.floor((486 - y) / 28)));
            rows.forEach((v, i) => {
                cv.text(fit(cv, v.head, 17, 330), 784, y + 20 + i * 28, 17, t.text, { font: 'bold' });
                cv.text(fit(cv, v.body, 17, 440), 1124, y + 20 + i * 28, 17, t.dim);
            });
            if (rows.length < values.length && (!cv.own || rawOpen)) cv.text('+ ' + (values.length - rows.length) + ' more in the log', 1552, 486, 16, t.dim, { align: 'right' });
            cv.text('BMW does not publish what these hold, so they show as bytes: nothing is named by a guess.', 784, 504, 16, t.dim);
        }

        /** Response times: how fast each unit answered us, and our own requests per second. */
        function drawBus(cv, t) {
            const v = scan && scan.demo || (!scan && useDemo()) ? demoView(DEMO.ecus.map((e) => e.addr)) : timing.view();
            tile(cv, t, 0, 'Requests sent', String(v.sent), 'by this app', t.text);
            tile(cv, t, 1, 'Replies', String(v.answered), 'one per unit asked', GO);
            tile(cv, t, 2, 'No answer', String(v.missed), 'timed out', v.missed ? t.warn : GO);
            tile(cv, t, 3, 'Waits', String(v.waits), '"pending" replies', v.waits ? t.warn : t.text);
            const L = G.panel(cv, t, 24, 176, 900, 336, 'How fast each unit answers us');
            const units = v.units.filter((u) => u.n).slice(0, 6);
            if (!units.length) { cv.text('No requests yet: Scan now, or open a fault', 48, 300, 24, t.dim); }
            const top = Math.max(200, ...units.map((u) => u.max || 0)), X = (ms) => 330 + 470 * Math.min(1, ms / top);
            units.forEach((u, i) => {
                const y = 232 + i * 44;
                cv.text(fit(cv, ecuName(u.addr), 19, 270), 48, y + 20, 19, t.text);
                cv.roundRect(330, y + 6, 470, 18, 6, t.track);
                cv.roundRect(330, y + 6, Math.max(8, X(u.avg) - 330), 18, 6, u.avg > 150 ? t.warn : t.accent);
                cv.fillRect(Math.round(X(u.max)) - 2, y + 1, 4, 28, t.crit);
                if (u.last !== null) { cv.circle(X(u.last), y + 15, 8, t.bg); cv.circle(X(u.last), y + 15, 5.5, t.warn); }
                cv.text(Math.round(u.avg) + ' ms', 896, y + 21, 18, t.text, { align: 'right', font: 'bold' });
            });
            cv.text('bar: average    red line: slowest    yellow dot: the last answer', 48, 500, 16, t.dim);
            const R = G.panel(cv, t, 940, 176, 636, 336, 'Our requests per second, last 60 s');
            const ymax = Math.max(4, ...v.perSec);
            G.chart(cv, t, 956, 226, 604, 200, { xMin: -60, xMax: 0, yMin: 0, yMax: ymax, xStep: 15, yStep: ymax > 8 ? Math.ceil(ymax / 4) : 1, xUnit: 's',
                series: [{ pts: v.perSec.map((n, i) => [i - 59, n]), color: t.accent, width: 2.5, fill: 0.2 }] });
            wrapLines(cv, 'The real load on the car\'s buses is not visible to an app: this shows how fast units answer us and how many requests we send.', 16, 588, 3)
                .forEach((ln, i) => cv.text(ln, 964, 452 + i * 22, 16, t.dim));
            void R; void L;
        }

        let drawn = -1;
        async function render(force) {
            if (!force && drawn === version && !gliding && phase !== 'scanning' && phase !== 'clearing' && !(detail && detail.phase === 'reading')
                && !(page === pageCount() - 1)) return;
            drawn = version;
            gliding = false;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const fp0 = pageCount() - 3;
            scrolls = !!cv.own;
            perPage = PER_PAGE + Math.floor((G.pageBottom(cv) - G.BOTTOM) / 47);     // rows of 47 px (drawCC; drawFaults' are 46)
            const fp = pageCount() - 3;
            // fewer or more fault pages now (the room below the page came or went): Check Control and Control
            // units stay the pages shown
            if (fp !== fp0) page = page >= fp0 ? fp + page - fp0 : Math.min(page, fp - 1);
            page = Math.min(page, pageCount() - 1);
            if (page < fp && detail) drawDetail(cv, t);
            else if (page === fp + 2) drawBus(cv, t);
            else {
                tiles(cv, t);
                if (page < fp) drawFaults(cv, t); else if (page === fp) drawCC(cv, t); else drawEcus(cv, t);
            }
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_SCAN', () => { doScan(); });
        ui.onClick('BTN_CLEAR', () => { doClear(); });
        // on the Faults page where the kit runs the screen
        ctx.hideButton('BTN_SCAN');
        ctx.hideButton('BTN_CLEAR');
        ctx.onLayout(changed);           // (it draws only on changes: a new layout is one)
        ui.onClick('BTN_PAGE', () => { if (detail) { closeDetail(); return; } page = (page + 1) % pageCount(); changed(); });
        ui.onClick('BTN_DETAIL', () => { const fp = pageCount() - 3; if (page >= fp) page = 0; nextDetail(); });
        // tabs: Faults (opened again: its next page of faults), Check Control, Control units
        ctx.onTab((i) => {
            const fp = pageCount() - 3;
            if (i === 0 && detail) detail = null;
            else if (i === 0 && page < fp) page = (page + 1) % fp;
            else page = i === 0 ? 0 : fp + i - 1;
            changed();
        });

        var loop = ctx.loop('MAIN', 2, () => render(false));
        let scannedOnOpen = false;
        const maybeAuto = () => {
            if (scannedOnOpen || !settings.get('autoScan')) return;
            scannedOnOpen = true;
            setTimeout(doScan, 1500);       // give TASU's availability a moment
        };
        // back from Settings or an HMI popup: draw again at once, and once more when the renderer's surface
        // is up - this app only draws when something changed, so the screen would otherwise stay empty
        // until the next change (e.g. Next page)
        const redraw = () => { changed(); setTimeout(changed, 600); };
        const shown = (on) => { away = !on; listen(on); if (on) { getDiag(); maybeAuto(); redraw(); } };
        ui.onVisible((name, on) => { if (name === 'MAIN') shown(on); });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.isVisible('MAIN')) shown(true);
        settings.onChange(() => changed());
        if (scan) ui.text('BTN_SCAN', 'Scan again');
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
