// The check-it's-you prompt: before a protected money change the shell asks for the user's computer password or
// fingerprint (src-tauri/src/auth.rs, PAM) and this card by the Roamie shows it, as the glyph lock screen does: the
// reason in plain words, the typed password as dots, the fingerprint mark (dotted arcs round a centre with a gap at
// the bottom; while it waits a scan band runs up it, amber; green once accepted, red and a shake when not recognised;
// gone when there is no reader or finger), a status line in the lock's words, and Cancel.
// It never holds the password: host.js keeps the keys in its hidden field, tells the card only how many there are,
// and sends the password to the shell itself. Colours are the scheme's in use (theme.js); the finger's are its amber,
// lime and red tones.
// API: Roamie.authCard.open({ reason, finger, near, onPress, onCancel }) → { set(value), focus(on), state(m), end(ok),
// close(), closed, select() }; Roamie.authHit(x, y), Roamie.authRect() for the click areas (host.js); and for tests
// Roamie.authStatus(s), fingerDots(), fingerColour(s), fingerAlpha(y, scan, s), fingerScan(ms).
(() => {
  const R = window.Roamie;
  if (!R) return;
  const css = `
.ra { --s: 2px; --ease: cubic-bezier(.2, .8, .2, 1);
  --notch: polygon(
    calc(var(--s) * 2) 0, calc(100% - var(--s) * 2) 0, calc(100% - var(--s) * 2) var(--s), calc(100% - var(--s)) var(--s),
    calc(100% - var(--s)) calc(var(--s) * 2), 100% calc(var(--s) * 2), 100% calc(100% - var(--s) * 2),
    calc(100% - var(--s)) calc(100% - var(--s) * 2), calc(100% - var(--s)) calc(100% - var(--s)),
    calc(100% - var(--s) * 2) calc(100% - var(--s)), calc(100% - var(--s) * 2) 100%, calc(var(--s) * 2) 100%,
    calc(var(--s) * 2) calc(100% - var(--s)), var(--s) calc(100% - var(--s)), var(--s) calc(100% - var(--s) * 2),
    0 calc(100% - var(--s) * 2), 0 calc(var(--s) * 2), var(--s) calc(var(--s) * 2), var(--s) var(--s), calc(var(--s) * 2) var(--s));
  position: fixed; z-index: 6; width: 320px; background: var(--line-hot); clip-path: var(--notch); padding: 2px; box-sizing: border-box;
  font: 400 12.5px/1.5 "Martian Mono", ui-monospace, Menlo, monospace; color: var(--ink);
  filter: drop-shadow(0 0 10px rgba(var(--accent-rgb), .18)) drop-shadow(0 8px 22px rgba(0, 0, 0, .45));
  opacity: 0; transform: scale(.98); transition: opacity .16s var(--ease), transform .16s var(--ease); pointer-events: none; cursor: default; }
.ra.on { opacity: 1; transform: none; pointer-events: auto; }
.ra-in { background: rgba(var(--bg-rgb), .97); clip-path: var(--notch); padding: 10px 14px 12px; }
.ra-head { display: flex; align-items: center; gap: 8px; font-size: 11px; line-height: 1.3; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); }
.ra-dot { width: 6px; height: 6px; background: var(--accent); box-shadow: 0 0 6px var(--accent); flex: none; }
.ra-why { margin: 8px 0 10px; color: var(--ink); overflow-wrap: anywhere; }
.ra-row { display: flex; align-items: center; gap: 14px; }
.ra-field { flex: 1; height: 36px; display: flex; align-items: center; justify-content: center; gap: 9px; background: var(--field);
  border: 1px solid var(--line-hi); border-radius: 18px; cursor: text; }
.ra.fail .ra-field { border-color: var(--danger); }
.ra.away .ra-field { border-color: var(--line); }
.ra-pip { width: 8px; height: 8px; border-radius: 4px; background: var(--ink); }
.ra-pip.off { background: var(--line-hi); }
.ra.fail .ra-pip { background: var(--danger); }
.ra-caret { width: 2px; height: 18px; background: var(--accent); animation: ra-blink 1s steps(2, jump-none) infinite; }
.ra.away .ra-caret { visibility: hidden; }
.ra.busy .ra-pip:not(.off) { animation: ra-wave .7s ease-in-out infinite; }
.ra-finger { width: 52px; height: 52px; flex: none; }
.ra-status { margin: 9px 0 0; min-height: 1.5em; font-size: 11.5px; color: var(--ink-3); }
.ra.fail .ra-status, .ra.miss .ra-status { color: var(--danger); }
.ra-foot { display: flex; justify-content: flex-end; margin-top: 8px; }
.ra-cancel { all: unset; padding: 3px 10px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); cursor: pointer; }
.ra-cancel:hover { color: var(--ink); background: var(--hover); }
.ra-cancel:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ra.shake .ra-row { animation: ra-shake .36s linear; }
@keyframes ra-blink { 50% { opacity: 0; } }
@keyframes ra-wave { 50% { opacity: .3; } }
@keyframes ra-shake { 14% { transform: translateX(-10px); } 36% { transform: translateX(10px); } 50% { transform: none; } 64% { transform: translateX(-10px); } 86% { transform: translateX(10px); } }
@media (prefers-reduced-motion: reduce) { .ra { transform: none; transition: opacity .1s linear; } .ra-caret, .ra.busy .ra-pip:not(.off), .ra.shake .ra-row { animation: none; } }
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------------------------------------------------------------- what it shows (pure)
  // The status line, in the lock's words. s: { busy, fail ('wrong' | 'locked' | 'error'), touchFail, touchOk, finger, ok }.
  const authStatus = (s) => (s.ok ? 'confirmed'
    : s.busy ? 'checking…'
      : s.fail === 'locked' ? (s.finger ? 'too many attempts · use your finger or wait a few minutes' : 'too many attempts · wait a few minutes')
        : s.fail === 'error' ? "couldn't check the password · try again"
          : s.fail ? 'wrong password · try again'
            : s.touchFail ? 'finger not recognised · try again'
              : s.finger ? 'enter password or touch the reader' : 'enter password');
  // The mark's dots in its 52 × 52 box: the centre, and arcs of radius 7 to 25 from -30° to 210° over the top (the gap
  // of 120° at the bottom), a dot every ~4.5 px along each, a little taller than wide. As the lock draws it.
  const fingerDots = () => {
    const out = [{ x: 26, y: 27 }];
    for (const r of [7, 13, 19, 25]) {
      const n = Math.round(r * 4.2 / 4.5);
      for (let i = 0; i <= n; i++) {
        const a = (-30 + 240 * i / n) * Math.PI / 180;
        out.push({ x: 26 + r * Math.cos(a), y: 27 - r * Math.sin(a) * 1.08 });
      }
    }
    return out;
  };
  // Like a reader's light: amber while it waits, green once accepted, red when not recognised.
  const fingerColour = (s) => { const T = R.theme.now.tones; return s.touchFail ? T.red : s.touchOk ? T.lime : T.amber; };
  // How lit a dot is: all of it once there is an answer; while waiting, by how near the scan band it is (y and scan
  // as fractions of the height).
  const fingerAlpha = (y, scan, s) => (s.touchOk || s.touchFail ? 1 : 0.25 + 0.75 * Math.max(0, 1 - Math.abs(y - scan) * 5));
  // The band's place, from below the bottom (1.15) to above the top (-0.15) every 1.5 s.
  const fingerScan = (ms) => 1.15 - 1.3 * (((ms % 1500) + 1500) % 1500) / 1500;
  const DOTS = fingerDots();
  const still = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  // ---------------------------------------------------------------- the card
  let el = null, why, field, finger, status, fctx = null, raf = 0, t0 = 0, cur = null, shakeT = 0;
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const build = () => {
    el = mk('section', 'ra');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', "Check it's you");
    const inner = mk('div', 'ra-in'), head = mk('div', 'ra-head'), dot = mk('span', 'ra-dot');
    dot.setAttribute('aria-hidden', 'true');
    head.append(dot, mk('span', '', "Check it's you"));
    why = mk('p', 'ra-why');
    const row = mk('div', 'ra-row');
    field = mk('div', 'ra-field');
    field.setAttribute('aria-hidden', 'true');
    finger = mk('canvas', 'ra-finger');
    finger.setAttribute('aria-hidden', 'true');
    row.append(field, finger);
    status = mk('p', 'ra-status');
    status.setAttribute('aria-live', 'polite');
    const foot = mk('div', 'ra-foot'), cancel = mk('button', 'ra-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => cur?.opts.onCancel?.());
    foot.append(cancel);
    inner.append(head, why, row, status, foot);
    el.append(inner);
    // A press anywhere on it but Cancel takes the keyboard back (after a click elsewhere gave it away).
    el.addEventListener('pointerdown', (e) => { if (!e.target?.closest?.('.ra-cancel')) cur?.opts.onPress?.(); });
    R.theme.apply(el);
    document.body.append(el);
  };
  R.theme.onChange(() => { if (el) R.theme.apply(el); });

  const paint = () => {
    if (!cur) return;
    const s = cur.s;
    status.textContent = authStatus(s);
    el.classList.toggle('busy', !!s.busy);
    el.classList.toggle('fail', !!s.fail);
    el.classList.toggle('miss', !!s.touchFail && !s.fail);
    el.classList.toggle('away', !cur.focused);
    const pips = [];
    for (let i = 0; i < Math.min(cur.n, 16); i++) pips.push(mk('span', 'ra-pip'));
    pips.push(mk('span', 'ra-caret'));
    for (let i = cur.n; i < 6; i++) pips.push(mk('span', 'ra-pip off'));
    field.replaceChildren(...pips);
    finger.style.display = s.finger || s.touchOk ? '' : 'none';
  };
  const shake = () => {
    el.classList.remove('shake');
    clearTimeout(shakeT);
    requestAnimationFrame(() => { el.classList.add('shake'); shakeT = setTimeout(() => el.classList.remove('shake'), 400); });
  };
  const bounds = () => { const S = R.safe ?? { top: 0, right: 0, bottom: 0, left: 0 }; return { l: S.left + 8, t: S.top + 8, r: innerWidth - S.right - 8, b: innerHeight - S.bottom - 8 }; };
  // Beside the Roamie (right of it, or left where there's no room), kept on screen; in the top left without one.
  const place = () => {
    const B = bounds(), w = el.offsetWidth || 320, h = el.offsetHeight || 150, p = cur?.opts.near?.();
    let x = B.l, y = B.t;
    if (p) {
      x = p.x + p.r + 18 + w <= B.r ? p.x + p.r + 18 : p.x - p.r - 18 - w;
      y = p.y - h / 2;
    }
    el.style.left = `${Math.round(Math.max(B.l, Math.min(x, B.r - w)))}px`;
    el.style.top = `${Math.round(Math.max(B.t, Math.min(y, B.b - h)))}px`;
  };
  const frame = (t) => {
    raf = 0;
    if (!cur) return;
    place();
    const s = cur.s;
    if (s.finger || s.touchOk) {
      const k = globalThis.devicePixelRatio || 1, px = Math.round(52 * k);
      if (finger.width !== px) { finger.width = finger.height = px; fctx = null; }
      fctx ??= finger.getContext('2d');
      if (fctx) {
        fctx.setTransform(k, 0, 0, k, 0, 0);
        fctx.clearRect(0, 0, 52, 52);
        fctx.fillStyle = fingerColour(s);
        const scan = still() ? 0.5 : fingerScan(t - t0);
        for (const d of DOTS) {
          fctx.globalAlpha = still() && !s.touchOk && !s.touchFail ? 0.7 : fingerAlpha(d.y / 52, scan, s);
          fctx.beginPath(); fctx.arc(d.x, d.y, 2, 0, Math.PI * 2); fctx.fill();
        }
        fctx.globalAlpha = 1;
      }
    }
    raf = requestAnimationFrame(frame);
  };

  const open = (opts = {}) => {
    if (!el) build();
    if (cur) cur.close();
    let done;
    const closed = new Promise((r) => { done = r; });
    const me = {
      opts, n: 0, focused: true,
      s: { busy: false, fail: null, touchFail: false, touchOk: false, finger: !!opts.finger, ok: false },
      close() {
        if (cur !== me) return;
        cur = null;
        el.classList.remove('on', 'shake');
        if (raf) { globalThis.cancelAnimationFrame?.(raf); raf = 0; }
        done();
      },
    };
    cur = me;
    why.textContent = String(opts.reason ?? '').slice(0, 300);
    t0 = performance.now();
    paint();
    place();
    el.classList.add('on');
    if (!raf) raf = requestAnimationFrame(frame);
    const live = () => cur === me;
    return {
      // How many characters were typed (the card never sees them). More of them clears the failures, as on the lock.
      set(value) {
        if (!live()) return this;
        const n = String(value ?? '').length;
        if (n > me.n) { me.s.fail = null; me.s.touchFail = false; }
        me.n = n; paint();
        return this;
      },
      focus(on) { if (live()) { me.focused = !!on; paint(); } return this; },
      // What the shell says: busy, fail, touchFail, touchOk, finger.
      state(m) {
        if (!live()) return this;
        const was = me.s;
        me.s = { ...was };
        if ('busy' in m) me.s.busy = !!m.busy;
        if ('fail' in m) me.s.fail = m.fail || null;
        if ('touchFail' in m) me.s.touchFail = !!m.touchFail;
        if ('touchOk' in m) me.s.touchOk = !!m.touchOk;
        if ('finger' in m) me.s.finger = !!m.finger;
        if ((me.s.fail && !was.fail) || (m.touchFail && !me.s.touchOk)) shake();
        paint();
        return this;
      },
      // Done: accepted shows green for a moment (host.js closes it).
      end(ok) { if (live()) { me.s = { ...me.s, busy: false, ok: !!ok, touchOk: !!ok || me.s.touchOk, touchFail: false, fail: ok ? null : me.s.fail }; paint(); } return this; },
      select() { return this; },
      close() { me.close(); },
      get closed() { return closed; },
    };
  };

  R.authCard = { open, get isOpen() { return !!cur; } };
  R.authHit = (x, y) => {
    if (!cur) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  // Where the card is, as [x, y, w, h] (null when closed): part of the window's click shape on Linux (host.js).
  R.authRect = () => {
    if (!cur) return null;
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  };
  Object.assign(R, { authStatus, fingerDots, fingerColour, fingerAlpha, fingerScan });
})();
