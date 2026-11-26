'use strict';
/**
 * fault_context.js - what a control unit stored together with one fault (UDS ReadDTCInformation, ISO 14229-1), read
 * when the user opens that fault, not for all faults at once (a handful of requests to one unit):
 *
 *   19 03                 which snapshot records the unit holds, per fault (DTC + record number pairs)
 *   19 04 <DTC> <rec>     one snapshot record: 59 04 <DTC> <status> <rec> <count> <DID> <data> [<DID> <data> ...]
 *   19 06 <DTC> <rec>     one extended data record: 59 06 <DTC> <status> <rec> <data>   (records 01 to 04 tried)
 *
 * Only the layout above is standard. What a snapshot identifier or an extended record holds is the maker's own (BMW
 * calls them environment conditions) and the repo has no table for them, so each is shown as its bytes, never named by
 * a guess. One record is asked for at a time so its data is unambiguous; a snapshot record with more than one identifier
 * can't be split without their lengths, so its bytes after the first identifier are kept whole.
 * Reads only: every request passes check() (service 19, sub-functions 03 / 04 / 06). Faults are never cleared here.
 *
 *   const c = await readContext(diag, 0x12, '102A5A');
 *   c = { status, snapshots: [{ rec, count, values: [{ did, bytes }], rest }], extended: [{ rec, bytes }],
 *         refused: { '04': nrc, ... }, requests, answered }
 *   statusBits(0x09) -> [{ bit, label, on }] the eight standard status bits in plain words
 */
const SID = 0x19, READS = [0x03, 0x04, 0x06], MAX_SNAP = 4, EXT_RECS = [0x01, 0x02, 0x03, 0x04];

/** The DTC status byte's eight bits (ISO 14229-1), as the page says them. */
const BITS = [
    [0x01, 'Failing right now'],
    [0x02, 'Failed during this drive'],
    [0x04, 'Pending (seen, not yet confirmed)'],
    [0x08, 'Confirmed and stored'],
    [0x10, 'Not tested since the last clear'],
    [0x20, 'Failed at least once since the last clear'],
    [0x40, 'Not tested yet during this drive'],
    [0x80, 'Asks for the warning lamp'],
];
const statusBits = (b) => BITS.map(([bit, label]) => ({ bit, label, on: typeof b === 'number' && (b & bit) !== 0 }));

const dtcBytes = (code) => {
    const n = parseInt(String(code).replace(/^0x/i, ''), 16) >>> 0;
    return [(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];
};

/** Throws unless the request only reads fault information (19 03 / 19 04 / 19 06). Exported for the tests. */
function check(sid, data) {
    if (sid !== SID) throw new Error('fault context: service ' + sid + ' is not allowed');
    if (!Array.isArray(data) || READS.indexOf(data[0]) < 0) throw new Error('fault context: sub-function not allowed');
}

/** A reply to this sub-function about this fault (59 <sub> <DTC> ...), or a refusal of service 19. */
function ours(u, sub, code) {
    if (!u || !u.length) return false;
    if (u[0] === 0x7F) return u[1] === SID;
    if (u[0] !== 0x59 || u[1] !== sub) return false;
    if (sub === 0x03) return true;
    const d = dtcBytes(code);
    return u.length < 5 || (u[2] === d[0] && u[3] === d[1] && u[4] === d[2]);
}

/** 59 03 (<DTC> <rec>)*: the snapshot record numbers held for this fault. */
function parseIds(u, code) {
    if (!u || u[0] !== 0x59 || u[1] !== 0x03) return null;
    const d = dtcBytes(code), out = [];
    for (let i = 2; i + 4 <= u.length; i += 4) {
        if (u[i] === d[0] && u[i + 1] === d[1] && u[i + 2] === d[2] && out.indexOf(u[i + 3]) < 0) out.push(u[i + 3]);
    }
    return out;
}

/** One snapshot record (59 04 <DTC> <status> <rec> <count> <DID> <data>...): null when the reply holds none. */
function parseSnapshot(u) {
    if (!u || u[0] !== 0x59 || u[1] !== 0x04 || u.length < 8) return null;
    const rec = u[6], count = u[7], body = u.slice(8);
    if (count === 1 && body.length >= 2) return { rec, count, values: [{ did: (body[0] << 8) | body[1], bytes: body.slice(2) }], rest: null };
    // several identifiers: only the first one's number is sure (their lengths are the maker's)
    const values = body.length >= 2 ? [{ did: (body[0] << 8) | body[1], bytes: null }] : [];
    return { rec, count, values, rest: body.length >= 2 ? body.slice(2) : body };
}

/** One extended data record (59 06 <DTC> <status> <rec> <data>): null when the reply holds none. */
function parseExtended(u) {
    if (!u || u[0] !== 0x59 || u[1] !== 0x06 || u.length < 7) return null;
    return { rec: u[6], bytes: u.slice(7) };
}

const status = (u) => (u && u[0] === 0x59 && (u[1] === 0x04 || u[1] === 0x06) && u.length >= 6 ? u[5] : null);

/**
 * Read what the unit at addr stored with fault code: the snapshot record numbers (19 03), each of those records (at most
 * MAX_SNAP), and extended records 01 to 04. A unit that doesn't answer at all stops the reading early.
 */
async function readContext(diag, addr, code, opts) {
    const o = opts || {};
    const out = { status: null, snapshots: [], extended: [], refused: {}, requests: 0, answered: 0, noAnswer: false };
    const ask = async (sub, extra) => {
        const data = [sub].concat(sub === 0x03 ? [] : dtcBytes(code)).concat(extra || []);
        check(SID, data);
        out.requests++;
        if (o.onStep) o.onStep(out.requests);
        const u = await diag.physical(addr, SID, data, o.timeoutMs || 4000, (r) => ours(r, sub, code));
        if (u) out.answered++;
        if (u && u[0] === 0x7F) out.refused[sub.toString(16).padStart(2, '0')] = u[2];
        if (out.status === null) out.status = status(u);
        return u;
    };
    const ids = await ask(0x03, []);
    if (!ids) { out.noAnswer = true; return out; }
    let recs = parseIds(ids, code);
    if (recs === null) recs = [0x01];          // the list refused: ask for the first record anyway
    for (const rec of recs.slice(0, MAX_SNAP)) {
        const s = parseSnapshot(await ask(0x04, [rec]));
        if (s) out.snapshots.push(s);
    }
    for (const rec of EXT_RECS) {
        const u = await ask(0x06, [rec]);
        if (!u) break;
        const e = parseExtended(u);
        if (e && e.bytes.length) out.extended.push(e);
    }
    return out;
}

/** A value's bytes as the page shows them: hex, and as one number when there are at most 4 bytes. */
function rawText(bytes) {
    if (!bytes || !bytes.length) return 'no bytes';
    const h = bytes.map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join(' ');
    return h + (bytes.length <= 4 ? '  (as a number: ' + asNumber(bytes) + ')' : '');
}
const asNumber = (bytes) => bytes.reduce((n, b) => n * 256 + b, 0);

/**
 * Identifiers seen in two or more snapshot records with at most 4 bytes: their numbers record by record (for a chart).
 * [{ did, points: [{ rec, value }] }]
 */
function series(snapshots) {
    const by = new Map();
    snapshots.forEach((s) => s.values.forEach((v) => {
        if (!v.bytes || !v.bytes.length || v.bytes.length > 4) return;
        if (!by.has(v.did)) by.set(v.did, []);
        by.get(v.did).push({ rec: s.rec, value: asNumber(v.bytes) });
    }));
    return Array.from(by.entries()).filter(([, p]) => p.length >= 2).map(([did, points]) => ({ did, points }));
}

/** Demo: what a unit might hold, in the standard layout (made-up bytes; the page says names are not known). */
function demoContext(code, statusByte) {
    let h = 0;
    String(code).split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    const n = 2 + (h % 3), snaps = [];
    for (let i = 1; i <= n; i++) {
        const v = 40000 + ((h >> (i * 3)) % 900) * 7 + i * 1300;
        snaps.push({ rec: i, count: 1, values: [{ did: 0x1700, bytes: [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF] }], rest: null });
    }
    snaps.push({ rec: n + 1, count: 3, values: [{ did: 0x1701, bytes: null }], rest: [0x00, 0x5E, 0x12, 0x17, 0x02, 0x0C, 0x80] });
    return { status: statusByte, snapshots: snaps, extended: [{ rec: 0x01, bytes: [1 + (h % 9)] }, { rec: 0x02, bytes: [0x00, 0x12, 0xD4] }],
        refused: {}, requests: 3 + n + 4, answered: 3 + n + 4, noAnswer: false, demo: true };
}

module.exports = { readContext, parseIds, parseSnapshot, parseExtended, statusBits, check, rawText, asNumber, series, demoContext, dtcBytes, BITS };
