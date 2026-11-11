// The user's pen on Windows: while the talk keys are held, the voice helper follows the cursor and sends its trail
// here (voice "ink" messages, in global screen points; voice-win/src/ink.rs). Drawn like voice/ink.swift draws it
// on macOS: teal with a dark edge and a soft glow, dimmer until it snaps shut round something (then a glow pulse and
// a tick), and lines that never close fade. The picture sent with what was said is the helper's own capture, with
// the strokes drawn into it; this canvas is left out of captures like the rest of the overlay. On a Wayland layer
// surface the mouse draws the same way (penDrag, below) and the shell makes the picture (linux.rs pen_area).
(() => {
  const R = window.Roamie;
  if (!R || typeof document === 'undefined') return;
  // The pen's size, the same as ink.js and voice/ink.swift; its colours are the scheme's (theme.js), like ink.js's.
  const RADIUS = 2.8;
  const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const loc = (x, y) => [x - (R.origin?.x ?? 0), y - (R.origin?.y ?? 0)];
  let cv = null, ctx = null, raf = 0, cur = null;
  const strokes = [];

  function canvas() {
    if (cv) return;
    cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '2147483000' });
    document.body.appendChild(cv);
    ctx = cv.getContext('2d');
    const fit = () => { const d = devicePixelRatio || 1; cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d); paint(); };
    addEventListener('resize', fit);
    fit();
  }

  function path(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) { ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); return; }
    // Through the midpoints, so the line stays smooth like the macOS pen.
    for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    ctx.lineTo(pts.at(-1)[0], pts.at(-1)[1]);
  }

  function paint() {
    if (!ctx) return;
    const d = devicePixelRatio || 1, t = performance.now(), { accent: ACC, edge: EDGE } = R.theme.now;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineCap = ctx.lineJoin = 'round';
    let moving = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      let a = s.closed ? 1 : 0.55;
      if (s.fadeAt != null) {
        const k = (t - s.fadeAt) / s.fadeMs;
        if (k >= 1) { strokes.splice(i, 1); continue; }
        if (k > 0) a *= 1 - k;
        moving = true;
      }
      let glow = 6;
      if (s.pulseAt != null) {
        const k = (t - s.pulseAt) / 320;
        if (k < 1) { glow = 6 + 10 * (k < 0.5 ? k * 2 : 2 - k * 2); moving = true; } else s.pulseAt = null;
      }
      ctx.globalAlpha = a;
      path(s.pts);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = EDGE; ctx.lineWidth = RADIUS * 2 + 2.5; ctx.stroke();
      ctx.shadowColor = R.theme.rgba(ACC, 0.75); ctx.shadowBlur = glow;
      ctx.strokeStyle = ACC; ctx.lineWidth = RADIUS * 2; ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    raf = moving ? requestAnimationFrame(paint) : 0;
  }
  const redraw = () => { if (!raf) raf = requestAnimationFrame(paint); };
  // A line that's still up is drawn again in the new scheme's colours.
  R.theme.onChange(() => { if (strokes.length) redraw(); });
  const fade = (s, ms, after = 0) => { s.fadeAt = performance.now() + after; s.fadeMs = reducedMQ.matches ? 120 : ms; };

  R.pen = (m) => {
    if (m.ev === 'start') { canvas(); cur = { pts: [loc(m.x, m.y)], closed: false }; strokes.push(cur); }
    else if (m.ev === 'pt' && cur) cur.pts.push(loc(m.x, m.y));
    else if (m.ev === 'snap' && cur) {
      // Closed into the loop that starts at `from`; what came before it (the run-up) goes.
      cur.pts = cur.pts.slice(m.from); cur.pts.push(cur.pts[0]);
      cur.closed = true;
      if (!reducedMQ.matches) cur.pulseAt = performance.now();
      R.sfx?.play('tick');
      cur = null;
    } else if (m.ev === 'drop' && cur) { fade(cur, 350); cur = null; }
    else if (m.ev === 'fade') { cur = null; for (const s of strokes) if (s.fadeAt == null) fade(s, 450, (+m.after || 0) * 1000); }
    redraw();
  };

  // ---------- the pen with the mouse ----------
  // Linux on a Wayland layer surface (host.js): nothing follows the cursor over other apps there, so while a take is
  // heard the overlay takes the mouse and a press and drag draws. The same smoothing and the same snapping shut as
  // the helper's (voice-win/src/ink.rs add_point, closing), drawn through R.pen with its messages, in global points.
  const CLOSE_GAP = 22, MIN_RUN = 110, MIN_SIDE = 26, MIN_FILL = 0.3, START_AFTER = 6;
  // A point added a little smoothed; false when it was too close to the last one to count.
  function addPoint(pts, p) {
    const last = pts.at(-1);
    if (!last) { pts.push(p); return true; }
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) return false;
    pts.push([last[0] + (p[0] - last[0]) * 0.65, last[1] + (p[1] - last[1]) * 0.65]);
    return true;
  }
  // Big enough both ways, and its outline holds a fair share of its box.
  function encloses(q) {
    if (q.length < 3) return false;
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (w < MIN_SIDE || h < MIN_SIDE) return false;
    let a = 0;
    for (let k = 0; k < q.length; k++) { const u = q[k], v = q[(k + 1) % q.length]; a += u[0] * v[1] - v[0] * u[1]; }
    return Math.abs(a) / 2 >= MIN_FILL * w * h;
  }
  // Where the loop the path has just closed starts (an index), or null.
  function closing(p, gap) {
    if (p.length < 8) return null;
    const end = p.at(-1);
    let run = 0;
    for (let i = p.length - 1; i > 0;) {
      run += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      i--;
      if (run >= MIN_RUN && Math.hypot(p[i][0] - end[0], p[i][1] - end[1]) <= gap && encloses(p.slice(i))) return i;
    }
    return null;
  }
  // shut: the loop it snapped into (the run-up before it goes, as on the helper's).
  const shut = (d, i) => { d.shut = d.pts.slice(i); d.shut.push(d.shut[0]); R.pen({ ev: 'snap', from: i }); };
  let drag = null;
  R.penDrag = {
    get on() { return !!drag; },
    down(x, y) { drag = { at: [x, y], pts: null, shut: null }; },
    move(x, y) {
      const d = drag;
      if (!d || d.shut) return;
      if (!d.pts) {
        if (Math.hypot(x - d.at[0], y - d.at[1]) < START_AFTER) return;
        d.pts = [d.at];
        R.pen({ ev: 'start', x: d.at[0], y: d.at[1] });
      }
      if (!addPoint(d.pts, [x, y])) return;
      const p = d.pts.at(-1);
      R.pen({ ev: 'pt', x: p[0], y: p[1] });
      const i = closing(d.pts, CLOSE_GAP);
      if (i != null) shut(d, i);
    },
    // The press ended: the stroke to send (the loop when it snapped shut, nearly closed counting; otherwise the line as
    // drawn, which stays on screen until the take ends: underlines count here), 'click' for a press that never moved
    // past a nudge, or null when nothing was pressed.
    up() {
      const d = drag;
      drag = null;
      if (!d) return null;
      if (!d.pts) return 'click';
      if (!d.shut) { const i = closing(d.pts, CLOSE_GAP * 1.8); if (i != null) shut(d, i); }
      return d.shut ?? d.pts;
    },
  };
})();
