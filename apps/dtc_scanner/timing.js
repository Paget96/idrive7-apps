'use strict';
/**
 * timing.js - how fast the control units answer this app, and how many requests it sends: the Response times page.
 *
 * The real load on the car's buses is not visible to an app (the head unit only passes our own requests and their
 * replies), so this measures what is: for each unit the time from our request to its answer (a "pending" 7F xx 78
 * reply in between counts as a wait, the time keeps running), the requests that got no answer, and our own requests
 * per second over the last 60 s. Nothing is sent for it: it watches the requests the scanner makes anyway.
 *
 *   const tm = new Timing();
 *   wrap(diag, tm)          the Diag's send / physical / functional measured (diag.js)
 *   tm.view(now)            { units: [{ addr, n, avg, max, last, waits, missed }], perSec: [60 counts], sent, answered,
 *                             missed, waits }
 *   demoView(addrs, now)    the same, made up, for the demo
 */
const WINDOW_MS = 60000;

class Timing {
    constructor(now) {
        this.now = now || Date.now;
        this.sends = [];            // times our requests went out (the last 60 s)
        this.total = 0;
        this.units = new Map();     // addr -> { n, sum, max, last, waits, missed }
    }

    sent() {
        const t = this.now();
        this.total++;
        this.sends.push(t);
        while (this.sends.length && t - this.sends[0] > WINDOW_MS) this.sends.shift();
    }

    unit(addr) {
        if (!this.units.has(addr)) this.units.set(addr, { n: 0, sum: 0, max: 0, last: null, waits: 0, missed: 0 });
        return this.units.get(addr);
    }

    answer(addr, ms, waits) {
        const u = this.unit(addr);
        u.n++; u.sum += ms; u.max = Math.max(u.max, ms); u.last = ms; u.waits += waits || 0;
    }

    miss(addr) { this.unit(addr).missed++; }

    view(now) {
        const t = now || this.now(), perSec = new Array(60).fill(0);
        this.sends.forEach((s) => { const i = 59 - Math.floor((t - s) / 1000); if (i >= 0 && i < 60) perSec[i]++; });
        const units = Array.from(this.units.entries()).map(([addr, u]) => ({ addr, n: u.n, avg: u.n ? u.sum / u.n : null, max: u.n ? u.max : null,
            last: u.last, waits: u.waits, missed: u.missed })).sort((a, b) => (b.max || 0) - (a.max || 0) || a.addr - b.addr);
        const sum = (k) => units.reduce((s, u) => s + u[k], 0);
        return { units, perSec, sent: this.total, answered: sum('n'), missed: sum('missed'), waits: sum('waits') };
    }
}

/** Measure a Diag (kit/diag.js): every send() is a request; physical() and functional() replies are timed per unit. */
function wrap(diag, tm) {
    if (!diag || diag._timed) return diag;
    diag._timed = true;
    const fn = (k) => (typeof diag[k] === 'function' ? diag[k].bind(diag) : null);
    const send = fn('send'), physical = fn('physical'), functional = fn('functional');
    // physical() and functional() send through send(): a link without its own send() counts at those instead
    if (send) diag.send = function (target, sid, data, opts) { tm.sent(); return send(target, sid, data, opts); };
    if (physical) diag.physical = async function (target, sid, data, timeoutMs, accept, opts) {
        if (!send) tm.sent();
        const t0 = tm.now();
        let waits = 0;
        const o = Object.assign({}, opts, { onPending: () => { waits++; if (opts && opts.onPending) opts.onPending(); } });
        const r = await physical(target, sid, data, timeoutMs, accept, o);
        if (r) tm.answer(target, tm.now() - t0, waits); else tm.miss(target);
        return r;
    };
    if (functional) diag.functional = function (sid, data, opts) {
        if (!send) tm.sent();
        const t0 = tm.now();
        const o = Object.assign({}, opts, { onReply: (ecu, n) => { tm.answer(ecu, tm.now() - t0, 0); if (opts && opts.onReply) opts.onReply(ecu, n); } });
        return functional(sid, data, o);
    };
    return diag;
}

/** Made-up numbers for the demo page: a scan's burst 20 s ago and a fault opened 6 s ago. */
function demoView(addrs, now) {
    const units = addrs.slice(0, 12).map((addr, i) => {
        const avg = 18 + ((addr * 37) % 70) + (addr === 0x12 ? 90 : 0), max = Math.round(avg * (1.6 + (i % 3) * 0.5));
        return { addr, n: 2 + (i % 4), avg, max, last: Math.round(avg * (0.8 + (i % 5) * 0.1)), waits: addr === 0x12 ? 2 : 0, missed: addr === 0x5D ? 1 : 0 };
    }).sort((a, b) => b.max - a.max);
    const perSec = new Array(60).fill(0);
    [[39, 1], [40, 1], [41, 1], [42, 2], [43, 1], [53, 3], [54, 4], [55, 3], [56, 1]].forEach(([i, n]) => { perSec[i] = n; });
    const sum = (k) => units.reduce((s, u) => s + u[k], 0);
    return { units, perSec, sent: perSec.reduce((a, b) => a + b, 0) + 6, answered: sum('n'), missed: sum('missed'), waits: sum('waits'), demo: true };
}

module.exports = { Timing, wrap, demoView, WINDOW_MS };
