/* Interactive widgets. Each one reads its inputs, recomputes, redraws its canvas
   and (where relevant) poses the 3D model through window.SW. */
(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (v, d = 0) => Number(v).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
  const TAU = 2 * Math.PI;

  // ---------- tiny canvas plot ----------
  function setupCanvas(cv) {
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; } // reallocating on every slider tick churns memory
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: r.width, h: r.height };
  }
  /* plot(cv, {x:[lo,hi], y:[lo,hi], xTicks, yTicks, xLabel, yLabel, series:[{pts:[[x,y]], color, width, dash}], marks:[{x,y,color,label}], vlines:[{x,color,label}], hlines}) */
  function plot(cv, o) {
    const { g, w, h } = setupCanvas(cv);
    const pad = { l: 46, r: 12, t: 12, b: o.xLabel ? 38 : 22 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const X = (v) => pad.l + ((v - o.x[0]) / (o.x[1] - o.x[0])) * pw;
    const Y = (v) => pad.t + (1 - (v - o.y[0]) / (o.y[1] - o.y[0])) * ph;
    const ink = css('--muted'), line = css('--line'), font = css('--font-data');
    g.clearRect(0, 0, w, h);
    g.font = `11px ${font}`;
    g.fillStyle = ink;
    g.strokeStyle = line;
    g.lineWidth = 1;
    (o.yTicks || []).forEach((t) => {
      g.beginPath(); g.moveTo(pad.l, Y(t) + 0.5); g.lineTo(w - pad.r, Y(t) + 0.5); g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(o.yFmt ? o.yFmt(t) : t, pad.l - 6, Y(t));
    });
    (o.xTicks || []).forEach((t) => {
      g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(o.xFmt ? o.xFmt(t) : t, X(t), h - pad.b + 6);
    });
    if (o.xLabel) { g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(o.xLabel, pad.l + pw / 2, h - 2); }
    if (o.yLabel) {
      g.save(); g.translate(11, pad.t + ph / 2); g.rotate(-Math.PI / 2);
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(o.yLabel, 0, 0); g.restore();
    }
    g.save();
    g.beginPath(); g.rect(pad.l, pad.t - 2, pw, ph + 4); g.clip();
    (o.vlines || []).forEach((v) => {
      g.strokeStyle = v.color || ink; g.setLineDash([4, 4]); g.beginPath();
      g.moveTo(X(v.x) + 0.5, pad.t); g.lineTo(X(v.x) + 0.5, pad.t + ph); g.stroke(); g.setLineDash([]);
    });
    (o.hlines || []).forEach((v) => {
      g.strokeStyle = v.color || ink; g.setLineDash([4, 4]); g.beginPath();
      g.moveTo(pad.l, Y(v.y) + 0.5); g.lineTo(pad.l + pw, Y(v.y) + 0.5); g.stroke(); g.setLineDash([]);
    });
    (o.series || []).forEach((s) => {
      g.strokeStyle = s.color; g.lineWidth = s.width || 2; g.setLineDash(s.dash || []);
      g.beginPath();
      s.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke(); g.setLineDash([]);
    });
    (o.bars || []).forEach((b) => {
      g.fillStyle = b.color; g.fillRect(X(b.x0), Y(b.y), X(b.x1) - X(b.x0), Y(o.y[0]) - Y(b.y));
    });
    g.restore();
    (o.marks || []).forEach((m) => {
      g.fillStyle = m.color; g.beginPath(); g.arc(X(m.x), Y(m.y), 4.5, 0, TAU); g.fill();
      if (m.label) {
        g.font = `12px ${font}`; g.fillStyle = css('--ink');
        const right = X(m.x) > pad.l + pw * 0.7;
        g.textAlign = right ? 'right' : 'left'; g.textBaseline = 'bottom';
        g.fillText(m.label, X(m.x) + (right ? -8 : 8), Y(m.y) - 6);
      }
    });
    (o.vlines || []).forEach((v) => {
      if (!v.label) return;
      g.font = `11px ${font}`; g.fillStyle = v.color || ink; g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillText(v.label, X(v.x) + 5, pad.t + 2);
    });
    return { X, Y, g, pad, pw, ph };
  }

  // Bind range/number inputs: on input -> fn(); keeps an <output for=...> in sync.
  function bind(root, update) {
    root.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', update));
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); }).observe(root);
    const redraw = () => update();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
    new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  const num = (root, id) => parseFloat($(`#${id}`, root).value);
  const out = (root, id, text) => { const el = $(`#${id}`, root); if (el) el.textContent = text; };

  // ============ 2.2 CoreXZ motor driver ============
  (function corexz() {
    const root = $('#w-corexz');
    if (!root) return;
    const a = $('#cx-a', root), b = $('#cx-b', root), cv = $('canvas', root);
    const LX = 115, LZ = 240; // mm travel used here
    function update() {
      let A = +a.value, B = +b.value;
      let X = (A + B) / 2, Z = (A - B) / 2;
      const Xc = Math.max(-LX, Math.min(LX, X)), Zc = Math.max(0, Math.min(LZ, Z));
      if (Xc !== X || Zc !== Z) {
        a.value = Xc + Zc; b.value = Xc - Zc;
        // the step=1 sliders round half values; recompute from what they now show so readouts agree
        A = +a.value; B = +b.value;
        X = Math.max(-LX, Math.min(LX, (A + B) / 2)); Z = Math.max(0, Math.min(LZ, (A - B) / 2));
      }
      out(root, 'cx-a-out', `${A > 0 ? '+' : ''}${fmt(A)} mm`);
      out(root, 'cx-b-out', `${B > 0 ? '+' : ''}${fmt(B)} mm`);
      out(root, 'cx-x', `${fmt(X, 1)} mm`);
      out(root, 'cx-z', `${fmt(Z, 1)} mm`);
      const cA = css('--motor-a'), cB = css('--motor-b'), acc = css('--ink');
      const p = plot(cv, {
        x: [-130, 130], y: [-20, 250], xTicks: [-100, 0, 100], yTicks: [0, 100, 200],
        xLabel: 'X, nozzle left–right (mm)', yLabel: 'Z (mm)',
        series: [
          { pts: [[0, 0], [A / 2, A / 2]], color: cA, width: 2, dash: [5, 4] },
          { pts: [[A / 2, A / 2], [A / 2 + B / 2, A / 2 - B / 2]], color: cB, width: 2, dash: [5, 4] },
          { pts: [[0, 0], [X, Z]], color: acc, width: 2.5 },
        ],
        marks: [{ x: X, y: Z, color: acc, label: `(${fmt(X)}, ${fmt(Z)})` }],
      });
      p.g.font = `11px ${css('--font-data')}`;
      p.g.fillStyle = cA; p.g.textAlign = 'left'; p.g.fillText('A pushes along +X+Z', p.pad.l + 6, p.pad.t + 12);
      p.g.fillStyle = cB; p.g.fillText('B pushes along +X−Z', p.pad.l + 6, p.pad.t + 28);
      if (window.SW) window.SW.setPose({ x: X / 10, z: Z / 10 });
    }
    root.querySelectorAll('[data-cx]').forEach((btn) => btn.addEventListener('click', () => {
      const [A, B] = btn.dataset.cx.split(',').map(Number);
      animateTo(A, B);
    }));
    let anim = 0;
    function animateTo(A1, B1) {
      cancelAnimationFrame(anim);
      const A0 = +a.value, B0 = +b.value, t0 = performance.now();
      const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900;
      const step = (t) => {
        const u = dur ? Math.min(1, (t - t0) / dur) : 1;
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        a.value = Math.round(A0 + (A1 - A0) * e); b.value = Math.round(B0 + (B1 - B0) * e);
        update();
        if (u < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    }
    root.addEventListener('pointerenter', () => window.SW && window.SW.view('kinematics'));
    bind(root, update);
    update();
  })();

  // ============ 5.2 microstep torque + resolution ============
  (function micro() {
    const root = $('#w-micro');
    if (!root) return;
    const cv = $('canvas', root);
    const steps = [1, 2, 4, 8, 16, 32, 64, 128];
    function update() {
      const m = +$('input[name="ms"]:checked', root).value;
      const spr = +$('#ms-motor', root).value;   // full steps per rev
      const teeth = +$('#ms-teeth', root).value;
      const res = (teeth * 2) / (spr * m) * 1000;  // µm
      const pct = Math.sin(Math.PI / 2 / m) * 100;
      out(root, 'ms-res', `${fmt(res, res < 10 ? 2 : 1)} µm`);
      out(root, 'ms-pct', `${fmt(pct, pct < 10 ? 1 : 0)} %`);
      out(root, 'ms-rot', `${fmt(teeth * 2)} mm`);
      const muted = css('--bar'), acc = css('--accent');
      plot(cv, {
        x: [0, steps.length], y: [0, 105], yTicks: [0, 50, 100], yFmt: (t) => t + '%',
        xTicks: steps.map((_, i) => i + 0.5), xFmt: (t) => '1/' + steps[Math.floor(t)],
        xLabel: 'Microstep setting', yLabel: 'Torque per microstep',
        bars: steps.map((s, i) => ({ x0: i + 0.18, x1: i + 0.82, y: Math.sin(Math.PI / 2 / s) * 100, color: s === m ? acc : muted })),
      });
    }
    bind(root, update);
    update();
  })();

  // ============ 4.3 belt pluck -> tension ============
  (function pluck() {
    const root = $('#w-pluck');
    if (!root) return;
    function update() {
      const f = num(root, 'pk-f'), L = num(root, 'pk-L') / 1000, mu = num(root, 'pk-mu') / 1000;
      out(root, 'pk-f-out', `${fmt(f)} Hz`);
      out(root, 'pk-L-out', `${fmt(L * 1000)} mm`);
      out(root, 'pk-mu-out', `${fmt(mu * 1000, 1)} g/m`);
      const T = mu * Math.pow(2 * L * f, 2);
      out(root, 'pk-T', `${fmt(T, 1)} N`);
      out(root, 'pk-bear', `${fmt(2 * T, 0)} N`);
    }
    bind(root, update);
    update();
  })();

  // ============ 6.3 bed heat-up ============
  (function heat() {
    const root = $('#w-heat');
    if (!root) return;
    const cv = $('canvas', root);
    const C = 610, A = 0.105, Atop = 0.0525, eps = 0.9, sigma = 5.67e-8;
    function update() {
      const P = num(root, 'ht-P'), target = num(root, 'ht-T'), amb = num(root, 'ht-amb'), hc = num(root, 'ht-h');
      out(root, 'ht-P-out', `${fmt(P)} W`);
      out(root, 'ht-T-out', `${fmt(target)} °C`);
      out(root, 'ht-amb-out', `${fmt(amb)} °C`);
      out(root, 'ht-h-out', `${fmt(hc)} W/m²K`);
      const loss = (T) => hc * A * (T - amb) + eps * sigma * Atop * (Math.pow(T + 273.15, 4) - Math.pow(amb + 273.15, 4));
      // steady state: P = loss(T); bisection
      let lo = amb, hi = 400;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; loss(mid) < P ? (lo = mid) : (hi = mid); }
      const Tmax = lo;
      const pts = []; let T = amb, tHit = null;
      for (let t = 0; t <= 1800; t += 2) {
        pts.push([t / 60, T]);
        if (tHit === null && T >= target) tHit = t;
        T += ((P - loss(T)) / C) * 2;
      }
      // only 30 min are simulated: a bed whose steady state clears the target gets there, just later
      out(root, 'ht-time', tHit !== null ? `${fmt(tHit / 60, 1)} min` : Tmax > target ? 'over 30 min' : 'never');
      out(root, 'ht-max', `${fmt(Tmax)} °C`);
      out(root, 'ht-loss', `${fmt(loss(target))} W`);
      const yTop = Math.max(140, Math.ceil((Math.max(target, Math.min(Tmax, 200)) + 10) / 20) * 20);
      plot(cv, {
        x: [0, 30], y: [0, yTop], xTicks: [0, 5, 10, 15, 20, 25, 30], yTicks: [0, 50, 100, 150, 200].filter((v) => v <= yTop),
        xLabel: 'Minutes after switch-on', yLabel: 'Bed °C',
        series: [{ pts, color: css('--accent'), width: 2.5 }],
        hlines: [{ y: target, color: css('--muted') }],
        marks: tHit === null ? [] : [{ x: tHit / 60, y: target, color: css('--ink'), label: `${fmt(target)} °C at ${fmt(tHit / 60, 1)} min` }],
      });
    }
    bind(root, update);
    update();
  })();

  // ============ 8.2 wire voltage drop ============
  (function wire() {
    const root = $('#w-wire');
    if (!root) return;
    function update() {
      const len = num(root, 'wr-len'), area = num(root, 'wr-area'), I = num(root, 'wr-I');
      out(root, 'wr-len-out', `${fmt(len, 2)} m`);
      out(root, 'wr-I-out', `${fmt(I, 1)} A`);
      const R = (1.7e-8 * 2 * len) / (area * 1e-6);
      const V = I * R, P = I * I * R;
      out(root, 'wr-R', `${fmt(R * 1000, 1)} mΩ`);
      out(root, 'wr-V', `${fmt(V, 2)} V`);
      out(root, 'wr-P', `${fmt(P, 1)} W`);
      const verdict = $('#wr-verdict', root);
      const bad = P > 5 || V > 0.5;
      verdict.textContent = bad ? 'Too thin: the wire heats its own insulation.' : 'Fine: losses are negligible.';
      verdict.dataset.state = bad ? 'bad' : 'ok';
    }
    bind(root, update);
    update();
  })();

  // ============ 9.3–9.4 Y resonance and ringing ============
  (function yres() {
    const root = $('#w-yres');
    if (!root) return;
    const cvF = $('#yr-curve', root), cvW = $('#yr-wall', root);
    const LOOP = 0.6;
    function update() {
      const L1 = num(root, 'yr-L1') / 1000, m = num(root, 'yr-m'), EA = num(root, 'yr-EA') * 1e5;
      const zeta = num(root, 'yr-z'), v = num(root, 'yr-v');
      out(root, 'yr-L1-out', `${fmt(L1 * 1000)} mm`);
      out(root, 'yr-m-out', `${fmt(m, 2)} kg`);
      out(root, 'yr-EA-out', `${fmt(EA / 1e5, 1)} × 10⁵ N`);
      out(root, 'yr-z-out', fmt(zeta, 2));
      out(root, 'yr-v-out', `${fmt(v)} mm/s`);
      const k = (L) => EA * (1 / L + 1 / (LOOP - L));
      const fn = (L) => Math.sqrt(k(L) / m) / TAU;
      const f = fn(L1), fd = f * Math.sqrt(1 - zeta * zeta);
      out(root, 'yr-k', `${fmt(k(L1) / 1e5, 1)} × 10⁵ N/m`);
      out(root, 'yr-fn', `${fmt(f)} Hz`);
      out(root, 'yr-gap', `${fmt(v / fd, 2)} mm`);
      const pts = [];
      for (let L = 0.06; L <= 0.5401; L += 0.005) pts.push([L * 1000, fn(L)]);
      // stiff belts or a light bed push f_n past 260 Hz; grow the axis so the curve and marker stay inside
      const fTop = Math.max(260, Math.ceil((Math.max(f, ...pts.map((p) => p[1])) * 1.08) / 50) * 50);
      const fStep = fTop > 300 ? 100 : 50;
      plot(cvF, {
        x: [0, 600], y: [0, fTop], xTicks: [0, 100, 200, 300, 400, 500, 600],
        yTicks: Array.from({ length: Math.floor(fTop / fStep) + 1 }, (_, i) => i * fStep),
        xLabel: 'Belt span from pulley to carriage, L₁ (mm)', yLabel: 'f_n (Hz)',
        series: [{ pts, color: css('--y-axis'), width: 2.5 }],
        marks: [{ x: L1 * 1000, y: f, color: css('--ink'), label: `${fmt(f)} Hz` }],
      });
      // wall after a corner: ripple x(t) = A e^{-ζωt} sin(ω_d t), plotted against distance s = v t
      const sMax = 20; // mm of wall shown
      const wpts = [];
      const wn = TAU * f, wd = TAU * fd;
      const ds = Math.min(0.02, v / fd / 20); // ≥20 samples per ripple, or fast ringing aliases into noise
      for (let s = 0; s <= sMax; s += ds) {
        const t = s / v;
        wpts.push([s, Math.exp(-zeta * wn * t) * Math.sin(wd * t)]);
      }
      plot(cvW, {
        x: [0, sMax], y: [-1.15, 1.15], xTicks: [0, 5, 10, 15, 20], yTicks: [0], yFmt: () => '',
        xLabel: 'Distance along the wall after a corner (mm)', yLabel: 'Ripple',
        series: [{ pts: wpts, color: css('--accent'), width: 2 }],
        vlines: [{ x: v / fd, color: css('--muted'), label: `one ripple = ${fmt(v / fd, 2)} mm` }],
      });
      if (window.SW) {
        const y = 11 - ((L1 * 1000 - 60) / 480) * 22;   // map L1 onto the model's Y travel (cm)
        window.SW.setPose({ y });
      }
    }
    root.addEventListener('pointerenter', () => window.SW && window.SW.view('yaxis'));
    bind(root, update);
    update();
  })();

  // ============ 9.5 input shaper ============
  (function shaper() {
    const root = $('#w-shaper');
    if (!root) return;
    const cv = $('canvas', root);
    function impulses(type, fs, zeta) {
      const wd = TAU * fs * Math.sqrt(1 - zeta * zeta);
      const K = Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta));
      const half = Math.PI / wd;
      if (type === 'zv') return [[1 / (1 + K), 0], [K / (1 + K), half]];
      if (type === 'zvd') {
        const d = (1 + K) * (1 + K);
        return [[1 / d, 0], [(2 * K) / d, half], [(K * K) / d, 2 * half]];
      }
      return [[1, 0]];
    }
    function update() {
      const fn = num(root, 'sh-fn'), zeta = num(root, 'sh-z'), fs = num(root, 'sh-fs');
      const type = $('input[name="sh-type"]:checked', root).value;
      out(root, 'sh-fn-out', `${fmt(fn)} Hz`);
      out(root, 'sh-z-out', fmt(zeta, 2));
      out(root, 'sh-fs-out', `${fmt(fs)} Hz`);
      const wn = TAU * fn, wd = wn * Math.sqrt(1 - zeta * zeta);
      const h = (t) => (t < 0 ? 0 : Math.exp(-zeta * wn * t) * Math.sin(wd * t));
      const imp = impulses(type, fs, zeta);
      const tEnd = imp[imp.length - 1][1];
      const raw = [], shaped = [];
      let peakRaw = 0, resid = 0;
      for (let t = 0; t <= 0.08; t += 0.0002) {
        const r = h(t), s = imp.reduce((acc, [A, ti]) => acc + A * h(t - ti), 0);
        raw.push([t * 1000, r]); shaped.push([t * 1000, s]);
        peakRaw = Math.max(peakRaw, Math.abs(r));
        if (t > tEnd + 1e-6) resid = Math.max(resid, Math.abs(s));
      }
      // residual vibration relative to unshaped, both measured after the shaper finishes
      let rawAfter = 0;
      raw.forEach(([tm, r]) => { if (tm / 1000 > tEnd + 1e-6) rawAfter = Math.max(rawAfter, Math.abs(r)); });
      const pct = type === 'none' ? 100 : (resid / rawAfter) * 100;
      out(root, 'sh-resid', `${fmt(pct, pct < 10 ? 1 : 0)} %`);
      out(root, 'sh-dt', type === 'none' ? '0 ms' : `${fmt(tEnd * 1000, 1)} ms`);
      plot(cv, {
        x: [0, 80], y: [-1.05, 1.05], xTicks: [0, 20, 40, 60, 80], yTicks: [-1, 0, 1], yFmt: (t) => (t === 0 ? '0' : ''),
        xLabel: 'Time after the corner (ms)', yLabel: 'Nozzle error',
        series: [
          { pts: raw, color: css('--bar'), width: 1.75 },
          ...(type === 'none' ? [] : [{ pts: shaped, color: css('--accent'), width: 2.5 }]),
        ],
        vlines: imp.slice(1).map(([, ti], i) => ({ x: ti * 1000, color: css('--muted'), label: i === 0 ? 'next impulse' : '' })),
      });
    }
    bind(root, update);
    update();
  })();

  // ============ exploded views: toggle animates, slider scrubs ============
  document.querySelectorAll('[data-explode]').forEach((root) => {
    const name = root.dataset.explode, input = $('input', root), btn = $('button', root), outEl = $('output', root);
    let anim = 0;
    function set(v, push = true) {
      input.value = Math.round(v);
      outEl.textContent = `${input.value} %`;
      btn.textContent = v > 50 ? 'Collapse' : 'Explode';
      btn.setAttribute('aria-pressed', String(v > 50));
      if (push && window.SW) window.SW.explode(name, v / 100);
    }
    input.addEventListener('input', () => { cancelAnimationFrame(anim); set(+input.value); });
    btn.addEventListener('click', () => {
      cancelAnimationFrame(anim);
      const v0 = +input.value, v1 = v0 > 50 ? 0 : 100, t0 = performance.now();
      const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1100;
      const step = (t) => {
        const u = dur ? Math.min(1, (t - t0) / dur) : 1, e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        set(v0 + (v1 - v0) * e);
        if (u < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    });
    // the viewer collapses the explosion when the reader moves to another view
    document.addEventListener('sw:collapse', (e) => { if (e.detail === name) { cancelAnimationFrame(anim); set(0, false); } });
  });

  // ============ BOM "show in model" + subsystem cards ============
  document.querySelectorAll('[data-show]').forEach((el) => {
    // 38 table buttons all read "Show"; give screen readers the part name
    if (el.textContent.trim() === 'Show') el.setAttribute('aria-label', `Show ${el.dataset.label || el.dataset.show} in the 3D model`);
    el.addEventListener('click', () => {
      if (!window.SW) return;
      // the stage is sticky, so it is already on screen; only reopen it if the reader collapsed it
      const wrap = document.getElementById('stage-wrap');
      if (wrap.classList.contains('is-collapsed')) document.getElementById('stage-toggle').click();
      window.SW.show(el.dataset.show.split('|'), el.dataset.label || el.textContent.trim());
    });
  });
})();
