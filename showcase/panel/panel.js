// The panel that opens from the menu bar or tray icon: a sidebar of pages. Home (what's going on) and Memory,
// then a page per group of settings: Model, Appearance, Voice, Money (the movements read from bank mails or added by hand,
// and the mail accounts they are read from), Behavior and About.
// The sidecar owns every value: it sends the whole state when the panel opens and after each change, and the
// panel sends back the same actions the menu used ({type:'menu', id}). Opened in a plain browser it shows a
// labelled preview with sample data instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAURI = window.__TAURI__?.core?.invoke;
  const invoke = TAURI ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const hide = () => invoke('panel_hide').catch(() => {});
  // An action from the menu's list. away: it happens on the desktop, so the panel steps aside first.
  const act = (id, away = false) => { if (away) hide(); send({ type: 'menu', id }); };
  // The colour scheme in use (theme.js) as this page's CSS variables and its light or dark, now and whenever it
  // changes. Which scheme that is follows the Colors setting, which comes with the state (themed: the one followed).
  const THEME = window.Roamie?.theme;
  THEME?.page(document.documentElement);
  let themed;

  let state = null, tab = 'home', deferred = false;
  // What's open in the panel itself: a key field (provider id or 'fish'), the row action waiting for its
  // Confirm, each long list's page (pg) and how many rows fit on one (per, measured), Memory's tab and its search.
  // Money's tab, the provider picked to add and the address typed (the app password is never kept here); its table
  // (mview, as the sidecar last sent it), its filters (mq), page and selected rows, the category picked for them or a
  // new one being typed (mnew), a category being renamed (mren), and the entry being added by hand (mform).
  const ui = { key: null, kind: {}, arm: null, pg: {}, per: {}, mtab: 'facts', vtab: 'replies', atab: 'look', ytab: 'moves', mprov: 'gmail', maddr: '', q: '', bindShown: new Set(),
    mview: null, mq: { month: '', category: undefined, group: 'all', text: '' }, mpage: 0, msel: new Set(), mcat: '', mnew: false, mren: false, mfocus: null, masked: null,
    mform: { kind: 'expense', amount: '', currency: 'PEN', description: '', date: '', category: '' } };
  let armTimer = 0;
  const disarm = () => { clearTimeout(armTimer); if (ui.arm) { ui.arm = null; return true; } return false; };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
      else if (k.startsWith('aria-') || k === 'role' || k.startsWith('data-')) n.setAttribute(k, String(v));
      else n[k] = v;
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };
  const btn = (label, onclick, { kind = 'ghost', k, disabled, wide, aria } = {}) =>
    el('button', { className: `px btn ${kind}${wide ? ' wide' : ''}`, type: 'button', textContent: label, disabled, 'data-k': k, 'aria-label': aria, on: { click: onclick } });
  const link = (label, onclick, { k, danger, aria, disabled } = {}) =>
    el('button', { className: `link${danger ? ' danger' : ''}`, type: 'button', textContent: label, 'data-k': k, 'aria-label': aria, disabled, on: { click: onclick } });
  // A row's action, played out: the row steps out, then the action goes. Re-rendering brings the list in line.
  const leave = (from, id) => { from.closest('.item')?.classList.add('leaving'); setTimeout(() => act(id), REDUCED.matches ? 0 : 190); };
  // Asks first in the same spot: the first press turns it into Confirm (for 4 s), the second does it.
  const armed = (label, yes, k, id, aria) => {
    const on = ui.arm === k;
    const b = el('button', { className: 'link danger arm', type: 'button', 'data-k': k, 'aria-pressed': String(on), 'aria-label': on ? `Confirm: ${aria}` : aria },
      el('span', { className: 'no', textContent: label, 'aria-hidden': 'true' }), el('span', { className: 'yes', textContent: yes, 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); b.setAttribute('aria-pressed', 'false'); return leave(b, id); }
      clearTimeout(armTimer); ui.arm = k; render(k);
      armTimer = setTimeout(() => { if (ui.arm === k) { ui.arm = null; render(); } }, 4000);
    });
    return b;
  };
  const group = (title, desc, n, ...kids) => el('div', { className: 'group' },
    el('div', { className: 'ghead' }, el('h2', {}, title, n != null ? el('span', { className: 'n', textContent: String(n) }) : null), desc ? el('p', { textContent: desc }) : null),
    ...kids);
  const toggle = (label, hint, on, onflip, k) => el('div', { className: 'setting' },
    el('span', { id: `lbl-${k}` }, label, hint ? el('small', { textContent: hint }) : null),
    el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `lbl-${k}`, 'data-k': k, on: { click: onflip } }));
  // tips: { value: text } shown in a tooltip on hover or keyboard focus, and read out as the option's description.
  const picks = (label, list, value, pick, k, tips = null) => el('div', { className: 'picks', role: 'radiogroup', 'aria-label': label },
    list.map(([v, text]) => el('button', {
      className: 'px chord', type: 'button', role: 'radio', 'aria-checked': String(v === value), tabIndex: v === value ? 0 : -1, 'data-k': `${k}:${v}`,
      'data-tip': tips?.[v] ?? null, 'aria-describedby': tips?.[v] ? `tip-${k}-${v}` : null,
      on: { click: () => v !== value && pick(v) },
    }, el('span', { className: 'px cap', textContent: text }), tips?.[v] ? el('span', { className: 'sr-only', id: `tip-${k}-${v}`, textContent: tips[v] }) : null)));

  // A dropdown drawn in the page. Not a <select>: its list is a popup window of its own, which takes the keyboard from
  // the panel, and on Linux the panel closes when it loses the keyboard (main.rs), so every pick closed it.
  // groups: [{ label?, items: [[value, text, disabled?]] }]; one open at a time (ui.dd).
  const dropdown = (label, groups, value, pick, k, placeholder = 'Pick one') => {
    const all = groups.flatMap((g) => g.items);
    const open = ui.dd === k, cur = all.find(([v]) => v === value);
    const close = (focus = true) => { ui.dd = null; render(focus ? k : undefined); };
    const move = (e, by) => {
      const opts = [...e.currentTarget.closest('.dd').querySelectorAll('[role="option"]:not([disabled])')];
      const i = opts.indexOf(document.activeElement);
      opts[Math.max(0, Math.min(opts.length - 1, (i < 0 ? opts.findIndex((o) => o.getAttribute('aria-selected') === 'true') : i) + by))]?.focus();
    };
    const keys = (e) => {
      if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) { ui.dd = k; render(`${k}:opt`); } else move(e, e.key === 'ArrowDown' ? 1 : -1); }
    };
    const opt = ([v, text, off]) => el('button', {
      className: 'ddopt', type: 'button', role: 'option', 'aria-selected': String(v === value), disabled: !!off,
      'data-k': v === value ? `${k}:opt` : null, title: text,
      on: { click: () => { ui.dd = null; if (v !== value) pick(v); render(k); } },
    }, text);
    return el('div', { className: `dd${open ? ' open' : ''}`, on: { keydown: keys } },
      el('button', {
        className: 'px field select ddbtn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': String(open), 'aria-label': `${label}: ${cur?.[1] ?? placeholder}`, 'data-k': k,
        on: { click: () => { ui.dd = open ? null : k; render(open ? k : `${k}:opt`); } },
      }, el('span', { className: 'ddval', textContent: cur?.[1] ?? placeholder })),
      open ? el('div', { className: 'ddlist', role: 'listbox', 'aria-label': label },
        groups.map((g) => (g.label ? [el('p', { className: 'ddgroup', textContent: g.label }), ...g.items.map(opt)] : g.items.map(opt)))) : null);
  };
  // A click anywhere outside the open dropdown closes it.
  document.addEventListener('pointerdown', (e) => { if (ui.dd && !e.target.closest?.('.dd.open')) { ui.dd = null; render(); } }, true);

  // ---- tooltip: one box, by whatever has a data-tip under the pointer or keyboard focus ----
  // It can be hovered (it sits right against its control), Esc closes it, and it never covers its control.
  let tipFor = null, tipTimer = 0;
  const tipBox = () => $('tip');
  function showTip(target) {
    clearTimeout(tipTimer);
    const t = tipBox(), text = target.dataset.tip;
    if (!text) return;
    if (tipFor !== target) { t.textContent = text; t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); }
    tipFor = target; t.hidden = false;
    const r = target.getBoundingClientRect(), gut = 12, w = Math.min(300, innerWidth - gut * 2);
    t.style.width = `${w}px`;
    const h = t.offsetHeight, below = r.bottom + 6 + h <= innerHeight - 8;
    const x = Math.round(Math.min(Math.max(r.left, gut), innerWidth - gut - w)), y = Math.round(below ? r.bottom + 6 : r.top - 6 - h);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    // The frame can be what "fixed" is measured from (its open/close effects): correct by where it actually landed.
    const at = t.getBoundingClientRect();
    t.style.left = `${x + (x - Math.round(at.left))}px`; t.style.top = `${y + (y - Math.round(at.top))}px`;
  }
  function hideTip(soon = false) {
    clearTimeout(tipTimer);
    if (soon) { tipTimer = setTimeout(() => hideTip(), 120); return; }
    tipFor = null; const t = tipBox(); if (t) t.hidden = true;
  }
  document.addEventListener('pointerover', (e) => { const x = e.target.closest?.('[data-tip]'); if (x) showTip(x); else if (e.target.closest?.('#tip')) clearTimeout(tipTimer); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip], #tip') && !e.relatedTarget?.closest?.('[data-tip], #tip')) hideTip(true); });
  document.addEventListener('focusin', (e) => { const x = e.target.closest?.('[data-tip]'); if (x && x.matches(':focus-visible')) showTip(x); else hideTip(); });
  document.addEventListener('focusout', () => hideTip(true));

  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  // Why pick each voice model: a line under the choice, and more in its tooltip with the cost.
  const WHY = { 'drama-3': 'More emotion. Slower, and costs more.', 's2.1-pro': 'Natural pace. Less emotion, costs less.' };
  const WHY_LONG = {
    'drama-3': 'The most expressive: whispers, laughs and real excitement. It talks slower, with pauses between sentences.',
    's2.1-pro': 'A natural, quicker pace. Feelings only come through lightly.',
  };
  // A spoken reply is about 200 characters (1 to 3 short sentences), so 100 replies are about 20,000. The offer's
  // last day is shown in Pacific time, as Fish states it (it ends Dec 1, 00:00 PT).
  const price = (c) => {
    const per100 = (perM) => `$${(perM * 0.02).toFixed(2)}`;
    const promo = c.promo && Date.now() < Date.parse(c.promo.until)
      ? ` (${per100(c.promo.perM)} until ${new Date(Date.parse(c.promo.until) - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'America/Los_Angeles' })})` : '';
    return `$${c.perM} per million characters: about ${per100(c.perM)} per 100 replies${promo}. Billed to your Fish Audio account.`;
  };
  const where = () => (state?.os === 'mac' ? 'your Keychain' : state?.os === 'win' ? 'Windows, encrypted for your account' : state?.os === 'linux' ? 'your keyring' : 'this computer');

  // ---------------------------------------------------------------- header
  function head() {
    const s = state.status;
    $('led').className = `led${s.state === 'ready' ? ' on' : s.state === 'busy' ? ' busy' : ''}`;
    const now = $('now');
    now.replaceChildren(el('b', { textContent: s.text }), state.model ? ` · ${state.model.name}` : s.state === 'off' ? ' · Sign in on the Model page' : '');
    now.title = now.textContent;
    $('ver').textContent = `v${state.version}`;
    updateButton();
    react();
    // The sidebar marks a page that needs you: no account to answer with.
    mark('model', s.state === 'off' ? 'not signed in' : null);
  }
  // One button for updates, updated in place (not rebuilt) so it keeps focus: Check for updates, then Update to x
  // (it downloads, installs and restarts), then Done. "Up to date" shows for a few seconds after a check.
  const FRESH = 6000;
  let freshTimer = 0;
  function updateButton() {
    const u = state.update, b = $('head-update'), v = u.available;
    const fresh = u.result?.ok && Date.now() - (u.result.at ?? 0) < FRESH;
    const [label, aria, kind, off] =
      u.done ? ['Done', `Roamies ${u.done} is installed. Restarting`, 'ghost', true]
      : u.installing ? ['Updating…', `Installing Roamies ${v}`, 'ghost', true]
      : v ? (u.page ? [`Get ${v}`, `Open the download page for Roamies ${v}`, 'primary', false] : [`Update to ${v}`, `Install Roamies ${v} and restart`, 'primary', false])
      : u.checking ? ['Checking…', 'Checking for updates', 'ghost', true]
      : fresh ? ['Up to date', `Roamies ${state.version} is up to date`, 'ghost', true]
      : u.result ? ['Check again', "Couldn't check for updates. Check again", 'ghost', false]
      : ['Check for updates', 'Check for updates', 'ghost', false];
    b.hidden = false; b.textContent = label; b.disabled = off;
    b.className = `px btn mini ${kind}`;
    b.setAttribute('aria-label', aria);
    b.title = u.result && !u.result.ok && !v && !u.checking ? `Couldn't check: ${u.result.error ?? 'unknown error'}` : '';
    clearTimeout(freshTimer);
    if (fresh) freshTimer = setTimeout(() => state && updateButton(), FRESH - (Date.now() - u.result.at) + 50);
  }
  $('head-update').addEventListener('click', () => act(state?.update?.available ? 'install_update' : 'update'));
  // Quit asks first: the first press turns it into Confirm for 4 s, the second quits.
  const quitB = $('head-quit');
  let quitTimer = 0;
  const unarmQuit = () => { clearTimeout(quitTimer); quitB.setAttribute('aria-pressed', 'false'); quitB.setAttribute('aria-label', 'Quit Roamies'); };
  quitB.addEventListener('click', () => {
    if (quitB.getAttribute('aria-pressed') === 'true') { unarmQuit(); act('quit'); return; }
    quitB.setAttribute('aria-pressed', 'true'); quitB.setAttribute('aria-label', 'Confirm: quit Roamies');
    quitTimer = setTimeout(unarmQuit, 4000);
  });
  function mark(page, why) {
    const b = $(`nav-${page}`);
    b.classList.toggle('flag', !!why);
    let sr = b.querySelector('.sr-only');
    if (why && !sr) b.append(sr = el('span', { className: 'sr-only' }));
    if (sr) { if (why) sr.textContent = ` (${why})`; else sr.remove(); }
  }

  // ---------------------------------------------------------------- live Roamies
  // The same LED renderer as on the desktop and in the setup guide, drawn small: one in the header (the Roamie
  // you have, reacting to what's going on) and one per look on the Appearance page. One loop draws them all,
  // only while the panel is up and each canvas is on screen. Their dots and glow are the colour scheme's, read
  // every frame, so a change of scheme shows on the next one.
  const live = new Set();
  let pointer = null; // the cursor in page px, for their eyes
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  const POSES = {
    think: (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    concerned: () => ({ arms: 0.7, tl: [-0.45, 0.95], tr: [0.45, 0.95], mouth: 'frown', brow: 'raised' }),
  };
  // A Roamie on a canvas of w×h CSS px: the one on screen at half scale (the app's unit, every dot half size), so
  // each size shows its own art (the full face, the small one, the pointer) at its real size next to the others.
  const ZOOM = 0.5, UNIT = 340;
  function liveRoamie(canvas, w, h, { look = 'classic', y = 0.56, form = 'default' } = {}) {
    if (!window.Roamie?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const z = ZOOM, unit = UNIT;
    w /= z; h /= z;
    const env = {
      w, h, dpr, t: 0, unit, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      pose: null, look, form,
      kit: Roamie.ditherKit({
        id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: () => 0.55 * Roamie.theme.now.glow, speed: 80, pal: () => Roamie.theme.now.led,
        // busy: no acts of its own; pose: whatever's going on, except while it's acting something out.
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => (clock < actUntil ? null : POSES[me.pose]?.(clock) ?? null) }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setLook(l) { if (l === me.look) return; me.look = l; me.kit.setLook(l); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      appear(v = 'materialize') { me.kit.appear(REDUCED.matches ? 'crt' : v, w / 2, h * y); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        // Eyes on the cursor, wherever it is in the panel; looking ahead when it's away.
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / z, y: (pointer[1] - r.top) / z, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook(look); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    live.add({ me, canvas });
    return me;
  }
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(1 / 30, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (document.hidden || $('frame').classList.contains('shut')) return;
    for (const { me, canvas } of live) if (canvas.isConnected && canvas.offsetParent) me.step(dt);
  }
  requestAnimationFrame(loop);

  // The header's Roamie: your look, reacting to what's going on. A short line beside it when something changes.
  // The same size and detail as the look tiles (fewer dots than that and the faces turn to noise).
  const avatar = liveRoamie($('avatar'), 100, 74, { y: 0.55 });
  const QUIPS = { classic: 'Classic me!', jarvis: 'At your service.', anime: 'Yay, hi hi!', sarah: 'Hey, nice to meet you!', adrian: "Alright, let's do this." };
  let quipTimer = 0, seen = { look: null, update: null, opened: 0 };
  function quip(text, secs = 2.6) {
    const q = $('saying'), n = $('by');
    clearTimeout(quipTimer);
    q.textContent = text; q.classList.add('on'); n.classList.add('quiet');
    quipTimer = setTimeout(() => { q.classList.remove('on'); n.classList.remove('quiet'); }, secs * 1000);
  }
  function react() {
    if (!avatar) return;
    avatar.pose = state.busy ? 'think' : state.status.state === 'off' ? 'concerned' : null;
    if (seen.look && state.look !== seen.look) { avatar.setLook(state.look); avatar.act('wave'); quip(QUIPS[state.look] ?? 'Hi!'); }
    else avatar.setLook(state.look);
    avatar.setForm(state.size);
    if (state.update.available && state.update.available !== seen.update && seen.look) { avatar.act('hype'); quip(`Roamies ${state.update.available} is here!`); }
    seen.look = state.look; seen.update = state.update.available;
  }

  // ---------------------------------------------------------------- Home
  function home() {
    const u = state.update;
    const mac = state.os === 'mac';
    return [
      el('div', { className: 'group' },
        el('h2', { className: 'sr-only', textContent: 'Actions' }),
        el('div', { className: 'actions' },
          btn('Ask', () => act('ask', true), { kind: u.available ? 'ghost' : 'primary', k: 'ask', disabled: state.busy, aria: `Ask ${state.name}` }),
          btn('Show list', () => act('list', true), { k: 'list' }),
          state.snap ?? mac ? btn('Ask about an area', () => act('snap', true), { k: 'snap' }) : null,
          state.busy ? btn('Stop', () => act('stop'), { k: 'stop' }) : btn('New chat', () => act('new'), { k: 'new', disabled: !state.canNew, aria: 'Start a new conversation' }),
          mac ? null : btn(`Show ${state.name}`, () => act('show', true), { k: 'show' }))),
      recentList(),
    ].flat();
  }
  function recentList() {
    const { box, nav } = paged('recent', state.recent, (r) => el('li', { className: `item ${r.kind}` },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', textContent: r.kind === 'ask' ? `“${r.text}”` : r.text, title: r.text }),
      el('span', { className: 'meta', textContent: ago(r.at) })), { label: 'Recent' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Recent' })), box),
      foot(state.usage ? el('p', { className: 'usage', textContent: `Today: ${state.usage.requests} request${state.usage.requests === 1 ? '' : 's'} · ${tokens(state.usage.tokens)} tokens` }) : null, nav),
    ];
  }

  // ---------------------------------------------------------------- pages of a long list
  // As many rows as fit (measured after drawing, see fit()), the rest a page away with the arrows in the footer.
  const EMPTY = 'Nothing yet…';
  // pin: the index of a row that must stay in view (an open key field), whatever page that puts it on.
  function paged(key, items, row, { label, empty = EMPTY, id, pin = -1 } = {}) {
    const per = ui.per[key] ?? 8, pages = Math.max(1, Math.ceil(items.length / per));
    if (pin >= 0) ui.pg[key] = Math.floor(pin / per);
    const pg = ui.pg[key] = Math.min(Math.max(0, ui.pg[key] ?? 0), pages - 1);
    const shown = items.slice(pg * per, pg * per + per);
    const box = el('div', { className: 'pagebox', 'data-pager': key, id },
      shown.length ? el('ul', { className: 'list', 'aria-label': label }, shown.map(row)) : el('p', { className: 'empty', textContent: empty }));
    return { box, nav: pages > 1 ? pager(key, pg, pages, label) : null };
  }
  // turn(page): a list the sidecar pages (Money's movements) asks for that page; the arrow keeps focus when it comes.
  function pager(key, pg, pages, label, turn = null) {
    const go = (d) => {
      disarm();
      // Keep focus on an arrow that still works at the end of the list.
      const edge = pg + d === 0 || pg + d === pages - 1;
      const k = `${key}:${edge ? (d < 0 ? 'next' : 'prev') : d < 0 ? 'prev' : 'next'}`;
      if (turn) { ui.mfocus = k; return turn(pg + d); }
      ui.pg[key] = pg + d;
      refresh(k);
    };
    return el('div', { className: 'pager', role: 'group', 'aria-label': `${label}: page ${pg + 1} of ${pages}` },
      btn('‹', () => go(-1), { kind: 'ghost mini', k: `${key}:prev`, disabled: pg === 0, aria: 'Previous page' }),
      el('span', { className: 'pnum', textContent: `${pg + 1} / ${pages}`, 'aria-hidden': 'true' }),
      btn('›', () => go(1), { kind: 'ghost mini', k: `${key}:next`, disabled: pg === pages - 1, aria: 'Next page' }));
  }
  // The page's footer: something about the whole list on the left, the arrows on the right; none when both are empty.
  const foot = (left, nav, id) => (left || nav ? el('div', { className: 'pfoot', id }, el('div', { className: 'pfoot-l' }, left), nav) : null);
  // How many rows fit in each list's box now; true when that changed (so it's drawn again). An open row (a key
  // field) takes its extra room off the page instead of setting the size of every row.
  function fit() {
    let changed = false;
    for (const box of document.querySelectorAll(`#pane-${tab} .pagebox`)) {
      const rows = [...box.querySelectorAll('.list > li')];
      if (!rows.length || !box.clientHeight) continue;
      const shut = rows.filter((r) => !r.classList.contains('open'));
      const unit = Math.max(...(shut.length ? shut : rows).map((r) => r.offsetHeight));
      const extra = rows.filter((r) => r.classList.contains('open')).reduce((n, r) => n + Math.max(0, r.offsetHeight - unit), 0);
      const per = Math.max(3, Math.floor((box.clientHeight - extra) / unit));
      if (per !== ui.per[box.dataset.pager]) { ui.per[box.dataset.pager] = per; changed = true; }
    }
    return changed;
  }

  // ---------------------------------------------------------------- Memory
  // Two tabs, What I remember and Commitments, each a page at a time; Get to know me at the end of the tab row.
  function memory() {
    const on = ui.mtab;
    const tabBtn = (id, label) => el('button', {
      className: 'tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(on === id), 'aria-controls': 'mem-panel', tabIndex: on === id ? 0 : -1, 'data-k': `tab-${id}`,
      on: { click: () => { if (ui.mtab !== id) { ui.mtab = id; disarm(); render(`tab-${id}`); } } },
    }, label);
    return [
      el('div', { className: 'mhead' },
        el('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Memory' }, tabBtn('facts', 'What I remember'), tabBtn('commits', 'Commitments')),
        link('Get to know me', () => act('intro', true), { k: 'intro', disabled: state.intro })),
      ...(on === 'commits' ? commitList() : factList()),
    ];
  }
  function factList() {
    const f = state.facts, q = ui.q.trim().toLowerCase();
    const hits = q ? f.filter((x) => x.text.toLowerCase().includes(q)) : f;
    const { box, nav } = paged('facts', hits, (x) => el('li', { className: 'item' },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', textContent: x.text, title: x.text }),
      armed('Forget', 'Confirm', `forget:${x.id}`, `forget:${x.id}`, `Forget: ${x.text}`)), { label: 'What I remember', empty: q ? `No match for "${ui.q.trim()}".` : EMPTY, id: 'facts-box' });
    // Search once there's more than a page: it looks through all of them, and the pages follow the matches.
    const search = f.length > (ui.per.facts ?? 8) || q ? el('div', { className: 'find' }, el('span', { className: 'px field' },
      el('input', { type: 'search', id: 'find-facts', value: ui.q, placeholder: `Search ${f.length} memories`, 'aria-label': 'Search what I remember', autocomplete: 'off', spellcheck: false,
        on: { input: (e) => { ui.q = e.target.value; ui.pg.facts = 0; refreshFacts(); }, keydown: (e) => { if (e.key === 'Escape' && ui.q) { e.preventDefault(); e.stopPropagation(); e.target.value = ui.q = ''; refreshFacts(); } } } }))) : null;
    return [
      el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-facts' }, search, box),
      foot(f.length ? armed('Forget everything', `Forget all ${f.length}`, 'forget-all', 'forgetall:yes', `Forget all ${f.length} things I remember`) : null, nav, 'facts-foot'),
    ];
  }
  // Searching redraws just the list and its footer, so the search field keeps its focus and caret.
  function refreshFacts() {
    const [panel, ft] = factList(), box = $('facts-box');
    if (!box) return render();
    box.replaceWith(panel.querySelector('#facts-box'));
    const old = $('facts-foot');
    if (old && ft) old.replaceWith(ft); else if (old) old.remove(); else if (ft) $('mem-panel').after(ft);
    if (fit()) refreshFacts();
  }
  function commitList() {
    const { box, nav } = paged('commits', state.commitments, (x) => el('li', { className: 'item' },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', title: x.text }, x.text, x.when ? el('small', { className: x.overdue ? 'late' : '', textContent: x.overdue ? `Overdue · ${x.when}` : x.when }) : null),
      el('span', { className: 'row-btns' },
        link('Done', (e) => leave(e.currentTarget, `done:${x.id}`), { k: `done:${x.id}`, aria: `Done: ${x.text}` }),
        armed('Drop', 'Confirm', `drop:${x.id}`, `drop:${x.id}`, `Drop: ${x.text}`))), { label: 'Commitments' });
    const n = state.commitments.length;
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-commits' }, box), foot(n ? el('p', { className: 'usage', textContent: `${n} open` }) : null, nav)];
  }
  // A page arrow: the search field (if it has focus) is kept by redrawing only the list.
  const refresh = (focusKey) => (tab === 'memory' && ui.mtab === 'facts' && document.activeElement?.id === 'find-facts' ? refreshFacts() : render(focusKey));

  // ---------------------------------------------------------------- Settings
  // A masked key field that opens in place. id: a provider, or 'fish'. kinds: the kinds of key it takes
  // (Kimi and Xiaomi: a plan key or a pay-per-token key), picked above the field; onsave gets the kind's id.
  function keyForm(id, label, onsave, kinds = null) {
    const kind = kinds?.find((x) => x.id === ui.kind[id]) ?? kinds?.[0];
    const name = kind?.label ?? label;
    const input = el('input', { type: 'password', id: `key-${id}`, autocomplete: 'off', spellcheck: false, placeholder: `${name} key`, 'aria-label': `${name} API key`, maxLength: 1000 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v, kind?.id); input.value = ''; ui.key = null; render(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); ui.key = null; render(`addkey:${id}`); } });
    const row = el('div', { className: 'keyform', hidden: ui.key !== id }, el('span', { className: 'px field' }, input), btn('Save', save, { k: `save:${id}` }));
    if (!kinds) return row;
    row.hidden = false;
    return el('div', { className: 'keykinds', hidden: ui.key !== id },
      picks(`${label} key type`, kinds.map((x) => [x.id, x.label]), kind.id, (v) => { ui.kind[id] = v; render(`kind-${id}:${v}`); }, `kind-${id}`,
        Object.fromEntries(kinds.map((x) => [x.id, x.billing]))),
      row);
  }

  // A plain text field that opens in place, as a key field does (id: what ui.key holds while it's open). value: what
  // is saved now, shown ready to change; onsave gets what was typed.
  function phraseForm(id, value, onsave) {
    const input = el('input', { type: 'text', id: `key-${id}`, autocomplete: 'off', spellcheck: false, value: value ?? '', placeholder: 'A word or two, like a name', 'aria-label': 'Wake phrase', maxLength: 40 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v); ui.key = null; render(`addkey:${id}`); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); ui.key = null; render(`addkey:${id}`); } });
    return el('div', { className: 'keyform', hidden: ui.key !== id }, el('span', { className: 'px field' }, input), btn('Save', save, { k: `save:${id}` }));
  }

  const signIn = (p) => link('Sign in', () => act(`login:${p.id}`), { k: `login:${p.id}`, aria: `Sign in to ${p.label}`, disabled: !!state.loggingIn });
  const addKey = (p) => link(ui.key === p.id ? 'Cancel' : 'Add key', () => { ui.key = ui.key === p.id ? null : p.id; render(ui.key ? `key-${p.id}` : `addkey:${p.id}`); }, { k: `addkey:${p.id}`, aria: `Add ${p.label} API key` });

  // Settings, one page per concern.
  function modelPage() {
    const on = state.providers.filter((p) => p.on);
    const model = state.model ? `${state.model.provider}:${state.model.id}` : '';
    const select = on.length ? dropdown('Model', on.map((p) => ({ label: p.label, items: p.models.map((m) => [`${p.id}:${m.id}`, m.name]) })), model, (v) => act(`model:${v}`), 'model', 'Pick a model') : null;
    const accounts = state.providers.filter((p) => p.on || p.method);
    const { box, nav } = paged('accounts', accounts, (p) => el('li', { className: `acct${ui.key === p.id ? ' open' : ''}` },
      el('div', { className: 'setting' },
        el('span', {}, p.label),
        p.on ? el('span', { className: 'ok' }, el('span', { className: 'led on', 'aria-hidden': 'true' }), 'Signed in')
          : state.loggingIn === p.id ? el('span', { className: 'waiting', textContent: 'Signing in…' })
          : p.method === 'oauth' ? (p.key ? el('span', { className: 'links' }, signIn(p), addKey(p)) : signIn(p))
          : addKey(p)),
      p.on || !(p.method === 'key' || p.key) ? null : keyForm(p.id, p.label, (key, kind) => send({ type: 'panel_key', provider: p.id, kind, key }), p.kinds)),
    { label: 'Accounts', pin: accounts.findIndex((p) => p.id === ui.key) });
    return [
      group('Model', 'Which AI answers you.', null,
        select ?? el('p', { className: 'empty', textContent: 'Sign in to an account below first.' })),
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Accounts' }), el('p', { textContent: 'Sign in to use their models.' })), box),
      foot(null, nav),
    ];
  }
  // Two tabs, the looks and the rest: the panel doesn't scroll, and as one page this had grown past its height, with
  // the Colors picker cut off at the bottom edge.
  function appearancePage() {
    const on = ui.atab;
    const tabBtn = (id, label) => el('button', {
      className: 'tab', type: 'button', role: 'tab', id: `atab-${id}`, 'aria-selected': String(on === id), tabIndex: on === id ? 0 : -1, 'data-k': `atab-${id}`,
      on: { click: () => { if (ui.atab !== id) { ui.atab = id; disarm(); render(`atab-${id}`); } } },
    }, label);
    const head = el('div', { className: 'mhead' }, el('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Appearance' }, tabBtn('look', 'Look'), tabBtn('style', 'Size and colors')));
    const look = [
      group('Look', 'Each look has its own name and voice.', null, lookTiles()),
    ];
    const style = [
      group('Size', 'How big I am on your screen.', null, picks('Size', state.sizes, state.size, (x) => act(`size:${x}`), 'size')),
      group('Colors', 'Mine, or your desktop\'s: light or dark, as it is.', null, picks('Colors', state.themes, state.theme, (x) => act(`theme:${x}`), 'theme')),
    ];
    return [head, ...(on === 'style' ? style : look)];
  }
  // The looks as live tiles: each one's character, playing, at the size picked on the other tab. Kept between renders (a state update mustn't restart
  // them); hovering or focusing one makes it wave; picking it makes it cheer.
  const tiles = new Map();
  function lookTiles() {
    const g = tiles.get('_group') ?? el('div', { className: 'looks', role: 'radiogroup', 'aria-label': 'Look' });
    tiles.set('_group', g);
    g.replaceChildren(...state.looks.map(([id, name]) => {
      let t = tiles.get(id);
      if (!t) {
        const cv = el('canvas', { 'aria-hidden': 'true' });
        const b = el('button', { className: 'px looktile', type: 'button', role: 'radio', 'data-k': `look:${id}` }, cv, el('span', { className: 'name', textContent: name }));
        const r = liveRoamie(cv, 104, 76, { look: id, y: 0.55, form: state.size });
        t = { b, r, waved: 0 };
        const wave = () => { if (r && Date.now() - t.waved > 3500) { t.waved = Date.now(); r.act('wave'); } };
        b.addEventListener('pointerenter', wave);
        b.addEventListener('focus', () => b.matches(':focus-visible') && wave());
        b.addEventListener('click', () => { if (state.look !== id) { r?.act('hype'); act(`look:${id}`); } });
        tiles.set(id, t);
        r?.appear('crt');
      }
      t.r?.setForm(state.size);
      const on = state.look === id;
      t.b.setAttribute('aria-checked', String(on)); t.b.tabIndex = on ? 0 : -1;
      return t.b;
    }));
    return g;
  }
  // Tabs, what I say (Replies), how you talk to me (Talking) and, on Linux, Other sounds: the panel doesn't scroll, and
  // as one page this had grown past its height, with the last settings cut off below the edge. Each tab fits with its
  // typing field open.
  function voicePage() {
    const v = state.voice, on = ui.vtab === 'sounds' && !state.duck ? 'replies' : ui.vtab;
    const tabBtn = (id, label) => el('button', {
      className: 'tab', type: 'button', role: 'tab', id: `vtab-${id}`, 'aria-selected': String(on === id), tabIndex: on === id ? 0 : -1, 'data-k': `vtab-${id}`,
      on: { click: () => { if (ui.vtab !== id) { ui.vtab = id; ui.key = null; disarm(); render(`vtab-${id}`); } } },
    }, label);
    const head = el('div', { className: 'mhead' }, el('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Voice' }, tabBtn('replies', 'Replies'), tabBtn('talking', 'Talking'), state.duck ? tabBtn('sounds', 'Other sounds') : null));
    // The voice (where the voice helper is): Fish Audio, or the local one, spoken on this computer. Only Fish's rows
    // show for Fish; the local voice shows its download, then whether the reply language suits it.
    const local = state.voiceEngine === 'local', lv = state.localVoice;
    const localLine = !lv ? '' : lv.status === 'downloading' ? `Downloading the voice… ${lv.pct}%` : lv.status === 'error' ? `The download failed. ${lv.error ?? ''}`.trim()
      : lv.status !== 'ready' ? `Needs a ${lv.size} download` : state.language === 'es' ? 'Spoken on this computer, offline and free.'
      : 'A Spanish voice: replies in other languages sound Spanish-accented. Pick Español below for the best result.';
    const replies = [
      group('Spoken replies', 'Hear me as well as read me.', null,
        picks('Replies', [['text', 'Text only'], ['voice', 'Voice and text']], state.replies, (x) => {
          if (x === 'voice' && !local && !state.fishKey) { ui.key = 'fish'; render('key-fish'); note('Add a Fish Audio key to hear me talk.'); return; }
          act(`replies:${x}`);
        }, 'replies'),
        state.engines ? [
          el('p', { className: 'sub', textContent: 'Voice' }),
          picks('Voice', state.engines, state.voiceEngine, (x) => act(`voiceengine:${x}`), 'voiceengine',
            { fish: 'Fish Audio, online: the most expressive voices, one per look. Needs your own Fish Audio key; billed to your account.', local: 'Made on this computer: offline, free and quick. One Spanish (Spain) voice for every look, downloaded once.' }),
          local ? el('p', { className: `why${lv?.status === 'error' || (lv?.status === 'ready' && state.language !== 'es') ? ' late' : ''}`, textContent: localLine }) : null,
          local && lv && (lv.status === 'missing' || lv.status === 'error') ? el('div', { className: 'links' }, link(lv.status === 'error' ? 'Retry the download' : `Download (${lv.size})`, () => act('localdl'), { k: 'localdl' })) : null,
        ] : null,
        !local && state.replies === 'voice' && state.fishModels?.length ? [
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.fishModels.map((c) => [c.id, c.name]), state.fishModel, (x) => act(`fishmodel:${x}`), 'fishmodel',
            Object.fromEntries(state.fishModels.map((c) => [c.id, `${WHY_LONG[c.id] ?? ''} ${price(c)}`.trim()]))),
          el('p', { className: `why${state.fishFree ? ' late' : ''}`, textContent: state.fishFree ? "No credit left, so it's on Fish's free tier" : WHY[state.fishModel] ?? '' }),
        ] : null,
        local ? null : el('div', { className: 'setting' },
          el('span', {}, 'Fish Audio key', el('small', { textContent: state.fishKey ? `Saved in ${where()}` : 'Needed for spoken replies' })),
          el('span', { className: 'row-btns' },
            link(ui.key === 'fish' ? 'Cancel' : state.fishKey ? 'Change' : 'Add', () => { ui.key = ui.key === 'fish' ? null : 'fish'; render(ui.key ? 'key-fish' : 'addkey:fish'); }, { k: 'addkey:fish', aria: state.fishKey ? 'Change the Fish Audio key' : 'Add a Fish Audio key' }),
            state.fishKey && ui.key !== 'fish' ? armed('Remove', 'Confirm', 'fishkey-remove', 'fishkey_remove', 'Remove the Fish Audio key') : null)),
        local ? null : keyForm('fish', 'Fish Audio', (key) => send({ type: 'panel_fishkey', key }))),
      // What I reply in, spoken and written: Auto leaves it to me, a picked one is kept whatever the screen is in.
      state.languages?.length ? group('Language', 'What I reply in, spoken and written.', null,
        picks('Language', state.languages, state.language, (x) => act(`language:${x}`), 'language')) : null,
    ];
    const talking = [
      v ? group('Talking to me', 'Speak instead of typing.', null,
        toggle('Voice control', v.download
          ? (v.download.status === 'downloading' ? `Downloading the voice model… ${v.download.pct}%` : v.download.status === 'error' ? 'The download failed' : `Needs a ${v.download.size} download`)
          : v.keys ? `Hold ${v.keys} to talk` : 'Press your talk shortcut to talk', v.on, () => act('voice'), 'voice'),
        v.download && v.download.status !== 'downloading' ? el('div', { className: 'links' }, link(v.download.status === 'error' ? 'Retry the download' : `Download (${v.download.size})`, () => act('voicedl'), { k: 'voicedl' })) : null,
        v.mac ? toggle('Mute Mac while talking', 'Other sounds go quiet while you talk', v.mute, () => act('mutetalk'), 'mutetalk') : null,
        // Linux on a layer surface: the mouse circles or underlines things while I listen, and has every click meanwhile.
        state.pen ? toggle('Draw with the mouse while I listen', 'Drag round what you mean; a click without dragging stops it', state.pen.on, () => act('pen'), 'pen') : null) : null,
      // Linux: saying the phrase starts listening, as the talk shortcut does. The microphone stays on to hear it.
      state.wake ? group('Wake word', 'Say a phrase and I listen, no key needed. The microphone stays on to hear it; nothing leaves this computer until you say it.', null,
        toggle('Wake word', !v?.on ? 'Needs Voice control on' : state.wake.phrase ? `Say "${state.wake.phrase}" to talk to me` : 'Pick a phrase to call me with', state.wake.on, () => {
          if (!state.wake.phrase) { ui.key = 'wake'; render('key-wake'); note('Type the phrase to call me with.'); return; }
          act('wake');
        }, 'wake'),
        el('div', { className: 'setting' },
          el('span', {}, 'Phrase', el('small', { textContent: state.wake.phrase || 'Not set' })),
          link(ui.key === 'wake' ? 'Cancel' : state.wake.phrase ? 'Change' : 'Set', () => { ui.key = ui.key === 'wake' ? null : 'wake'; render(ui.key ? 'key-wake' : 'addkey:wake'); }, { k: 'addkey:wake', aria: state.wake.phrase ? 'Change the wake phrase' : 'Set the wake phrase' })),
        phraseForm('wake', state.wake.phrase, (phrase) => send({ type: 'panel_wake', phrase }))) : null,
    ];
    const sounds = [
      // Linux: other apps are turned down while I listen and while I talk, to a share of what each has, and get it back after.
      state.duck ? group('Other sounds', 'Turn other apps down while I listen and while I talk.', null,
        toggle('Lower other sounds', 'They come back when I stop', state.duck.on, () => act('duck'), 'duck'),
        state.duck.on ? [
          el('p', { className: 'sub', textContent: 'Lower to' }),
          picks('Lower to', state.duck.levels.map((l) => [l, `${l}%`]), state.duck.level, (x) => act(`ducklevel:${x}`), 'ducklevel'),
        ] : null) : null,
    ];
    return [head, ...(on === 'talking' ? talking : on === 'sounds' ? sounds : replies)];
  }
  // Money: the movements read from bank mails or added by hand (the sidecar filters them and sends a page at a time),
  // adding one by hand, and the mail accounts bank notifications are read from (read-only) with adding one and each
  // provider's way to an app password. Tabs: the panel doesn't scroll.
  const MAIL_HELP = {
    gmail: 'Gmail needs an app password: turn on 2-Step Verification in your Google Account, then create one at myaccount.google.com/apppasswords. Revoke it there at any time; changing your Google password revokes it too.',
    yahoo: 'Yahoo needs an app password: Account Info, Account Security, Generate app password. Revoke it there at any time: it keeps working after you change your Yahoo password, so revoke it when you stop using Roamies.',
    outlook: "Coming soon: Outlook.com no longer takes app passwords and needs a Microsoft sign-in, which Roamies doesn't have yet.",
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
  const movesPer = () => Math.min(50, ui.per.moves ?? 8);
  // The table's query as the sidecar takes it (category null: not classified; left out: every one). Every message
  // carries it, so what comes back is the table as it is shown.
  const mquery = () => ({ month: ui.mq.month, ...(ui.mq.category === undefined ? {} : { category: ui.mq.category }), group: ui.mq.group, text: ui.mq.text.trim().slice(0, 200), page: ui.mpage, per: movesPer() });
  const moneyDo = (op, args = {}) => send({ type: 'panel_money', op, ...args, query: mquery() });
  const moneyAsk = () => moneyDo('list');
  // Before a protected change (the sidecar asks for the password or fingerprint): where the prompt shows.
  const askFirst = () => note('Confirm it is you: the prompt is by your Roamie.');
  const clearSel = () => { ui.msel.clear(); ui.mnew = false; };
  const choose = (label, list, value, pick, k) => dropdown(label, [{ items: list }], value, pick, k);
  let findTimer = 0;

  function moneyPage() {
    const m = state.money, on = ui.ytab;
    const tabBtn = (id, label) => el('button', {
      className: 'tab', type: 'button', role: 'tab', id: `ytab-${id}`, 'aria-selected': String(on === id), tabIndex: on === id ? 0 : -1, 'data-k': `ytab-${id}`,
      on: { click: () => { if (ui.ytab !== id) { ui.ytab = id; disarm(); clearSel(); ui.mren = false; render(`ytab-${id}`); } } },
    }, label);
    const head = el('div', { className: 'mhead' }, el('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Money' }, tabBtn('moves', 'Movements'), tabBtn('entry', 'Add by hand'), tabBtn('accounts', 'Accounts'), tabBtn('add', 'Add account')));
    if (on === 'moves') return [head, ...movesPage()];
    if (on === 'entry') return [head, entryForm()];
    if (on === 'add') {
      const p = ui.mprov;
      const addr = el('input', { type: 'email', id: 'key-mailaddr', value: ui.maddr, autocomplete: 'off', spellcheck: false, placeholder: 'Email address', 'aria-label': 'Email address', maxLength: 200, on: { input: (e) => { ui.maddr = e.target.value; } } });
      const pass = el('input', { type: 'password', id: 'key-mailpass', autocomplete: 'off', spellcheck: false, placeholder: 'App password', 'aria-label': 'App password', maxLength: 200 });
      const save = () => {
        const email = addr.value.trim(), password = pass.value.trim();
        if (!email) return addr.focus();
        if (!password) return pass.focus();
        send({ type: 'panel_mail_add', provider: ui.mprov, email, password });
        pass.value = ''; ui.maddr = ''; ui.ytab = 'accounts'; render('ytab-accounts');
      };
      for (const f of [addr, pass]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      return [head, group('Add an account', null, null,
        picks('Provider', [['gmail', 'Gmail'], ['yahoo', 'Yahoo'], ['outlook', 'Outlook (soon)']], p, (x) => { ui.mprov = x; render(`mprov:${x}`); }, 'mprov'),
        el('p', { className: 'why wrap', textContent: MAIL_HELP[p] }),
        p === 'outlook' ? null : [
          el('div', { className: 'keyform' }, el('span', { className: 'px field' }, addr)),
          el('div', { className: 'keyform' }, el('span', { className: 'px field' }, pass), btn('Save', save, { k: 'mail-save' })),
          el('p', { className: 'why wrap', textContent: `The app password stays in ${where()}. I only read your banks' mails and never move, mark or delete anything.` }),
        ])];
    }
    const { box, nav } = paged('mail', m.accounts, (a) => el('li', { className: 'item' },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', title: a.status ? `${a.email}: ${a.status.text}` : a.email }, `${a.label} · ${a.email}`,
        el('small', { className: a.status?.state === 'error' ? 'late' : '', textContent: a.status ? `${a.status.text}${a.status.at ? ` · ${ago(a.status.at)}` : ''}` : 'Not checked yet' })),
      el('span', { className: 'row-btns' },
        link('Test', () => act(`mail_test:${a.id}`), { k: `mail-test:${a.id}`, aria: `Test the connection to ${a.email}` }),
        armed('Remove', 'Confirm', `mail-remove:${a.id}`, `mail_remove:${a.id}`, `Remove ${a.email} and its app password`))),
    { label: 'Mail accounts', empty: 'No account yet: add one to read your bank mails.' });
    // The recipients marked as the user's own accounts (from a transfer on Movements): unmarking asks who it is.
    const { box: obox, nav: onav } = paged('own', ui.mview?.own ?? [], (o) => el('li', { className: 'item' },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', title: o.name }, o.name, el('small', { textContent: `${o.count} transfer${o.count === 1 ? '' : 's'}, not counted` })),
      link('Unmark', () => { askFirst(); moneyDo('own', { action: 'unmark', key: o.key }); }, { k: `own-unmark:${o.key}`, aria: `Unmark ${o.name} as your own account` })),
    { label: 'Your own accounts', empty: 'None yet: select a transfer on Movements and mark it as yours.' });
    return [head,
      group('Check every', 'How often I look for new bank mails while I run.', null,
        picks('Check every', m.everys.map((n) => [n, `${n} min`]), m.every, (x) => act(`mailevery:${x}`), 'mailevery')),
      el('div', { className: 'group paged', role: 'tabpanel', 'aria-labelledby': 'ytab-accounts' },
        el('div', { className: 'ghead' }, el('h2', { textContent: 'Mail accounts' }), el('p', { textContent: 'Read-only: nothing is moved, marked or deleted.' })), box),
      foot(null, nav),
      el('div', { className: 'group paged' },
        el('div', { className: 'ghead' }, el('h2', { textContent: 'Your own accounts' }), el('p', { textContent: 'Transfers to them are neither spending nor income.' })), obox),
      foot(null, onav)];
  }

  // The movements: the filters (or, with rows selected, what to do with them), a page of rows, and the totals of
  // everything the filters let through.
  function movesPage() {
    const v = ui.mview;
    if (!v) return [el('p', { className: 'empty', textContent: 'Loading…' })];
    const sel = v.rows.filter((r) => ui.msel.has(r.id));
    const filtered = ui.mq.month || ui.mq.category !== undefined || ui.mq.group !== 'all' || ui.mq.text.trim();
    const box = el('div', { className: 'pagebox', 'data-pager': 'moves', id: 'moves-box' },
      v.rows.length ? el('ul', { className: 'list', 'aria-label': 'Movements' }, v.rows.map(moveRow))
        : el('p', { className: 'empty wrap', textContent: filtered ? 'Nothing matches these filters.' : 'No movements yet: they come from your bank mails, or add one by hand.' }));
    const nav = v.pages > 1 ? pager('moves', v.page, v.pages, 'Movements', (pg) => { ui.mpage = pg; clearSel(); moneyAsk(); }) : null;
    const sums = v.totals.map((t) => [`${t.spent} out`, t.received.endsWith(' 0.00') ? null : `${t.received} in`].filter(Boolean).join(', '));
    const sum = v.total ? `${v.total} movement${v.total === 1 ? '' : 's'} · ${sums.join(' · ')}` : '';
    return [
      el('div', { className: 'group paged', role: 'tabpanel', id: 'moves-panel', 'aria-labelledby': 'ytab-moves' }, sel.length ? selBar(sel) : filters(v), box),
      foot(sum ? el('p', { className: 'usage', textContent: sum, title: sum }) : null, nav, 'moves-foot'),
    ];
  }
  function moveRow(r) {
    const on = ui.msel.has(r.id), sign = r.status === 'Income' ? '+' : '';
    const what = `${r.text}, ${sign}${r.amount}, ${r.date}`;
    return el('li', { className: 'item mrow' },
      r.classifiable || r.manual || r.own ? el('button', {
        className: 'px chord pick', type: 'button', role: 'checkbox', 'aria-checked': String(on), 'aria-label': `Select: ${what}`, 'data-k': `msel:${r.id}`,
        on: { click: () => { if (on) ui.msel.delete(r.id); else ui.msel.add(r.id); ui.mnew = false; render(`msel:${r.id}`); } },
      }, el('span', { className: 'px cap', 'aria-hidden': 'true', textContent: on ? '✓' : '' })) : el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', title: [r.text, r.note].filter(Boolean).join(' · ') }, r.text, el('small', { textContent: `${r.date} · ${r.kind} · ${r.source}` })),
      el('span', { className: 'text amt' }, `${sign}${r.amount}`, el('small', { className: r.status === 'Needs review' ? 'late' : '', textContent: r.category ?? r.status })));
  }
  function filters(v) {
    const q = ui.mq, named = typeof q.category === 'string';
    const set = (patch, k) => { Object.assign(q, patch); ui.mpage = 0; ui.mren = false; moneyAsk(); render(k); };
    const find = el('span', { className: 'px field' }, el('input', {
      type: 'search', id: 'find-money', value: q.text, placeholder: 'Search', 'aria-label': 'Search movements', autocomplete: 'off', spellcheck: false, maxLength: 200,
      on: {
        input: (e) => { q.text = e.target.value; ui.mpage = 0; clearTimeout(findTimer); findTimer = setTimeout(moneyAsk, 200); },
        keydown: (e) => { if (e.key === 'Escape' && q.text) { e.preventDefault(); e.stopPropagation(); e.target.value = q.text = ''; moneyAsk(); } },
      },
    }));
    return el('div', { className: 'mtools' },
      el('div', { className: 'mfilters' },
        choose('Month', [['', 'All months'], ...v.months.map((x) => [x, monthName(x)])], q.month, (x) => set({ month: x }, 'mmonth'), 'mmonth'),
        choose('Category', [['', 'All categories'], ['null', 'Not classified'], ...v.categories.map((c) => [JSON.stringify(c), c])], q.category === undefined ? '' : JSON.stringify(q.category),
          (x) => set({ category: x ? JSON.parse(x) : undefined }, 'mcatf'), 'mcatf'),
        choose('Kind', [['all', 'Everything'], ['spending', 'Spending'], ['income', 'Income'], ['other', 'Not counted']], q.group, (x) => set({ group: x }, 'mgroup'), 'mgroup')),
      named && ui.mren ? renameForm(q.category) : el('div', { className: 'keyform' }, find,
        named ? el('span', { className: 'row-btns mlinks' },
          link('Rename', () => { ui.mren = true; render('key-mrename'); }, { k: 'mrename', aria: `Rename the category ${q.category}` }),
          link('Delete', () => { askFirst(); moneyDo('delete_category', { name: q.category }); }, { k: 'mcatdel', danger: true, aria: `Delete the category ${q.category}` })) : null));
  }
  // Renaming the category the table is filtered by: the table follows it under its new name.
  function renameForm(name) {
    const input = el('input', { type: 'text', id: 'key-mrename', value: name, autocomplete: 'off', spellcheck: false, 'aria-label': `New name for ${name}`, maxLength: 40 });
    const save = () => {
      const to = input.value.trim();
      if (!to || to === name) return input.focus();
      askFirst(); ui.mren = false; ui.mq.category = to;
      moneyDo('rename_category', { from: name, to }); render('mrename');
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); ui.mren = false; render('mrename'); } });
    return el('div', { className: 'keyform' }, el('span', { className: 'px field' }, input), btn('Rename', save, { k: 'mrename-save' }));
  }
  // What to do with the rows selected: put them in a category (or a new one typed here), take their category away,
  // mark a transfer's recipient as the user's own account, delete an entry added by hand.
  function selBar(sel) {
    const ids = sel.map((r) => r.id), cls = sel.filter((r) => r.classifiable), named = cls.filter((r) => r.category);
    const put = () => {
      const field = $('key-mnewcat'), name = ui.mnew ? field?.value.trim() : ui.mcat;
      if (!name) return (ui.mnew ? field : document.querySelector('[data-k="mcat"]'))?.focus();
      if (sel.some((r) => r.category && r.category.toLowerCase() !== name.toLowerCase())) askFirst();
      moneyDo('classify', { ids, category: name, create: ui.mnew || undefined });
      clearSel(); render('find-money');
    };
    const pick = cls.length < sel.length ? el('p', { className: 'why', textContent: 'Income and what is not counted have no category.' })
      : el('div', { className: 'keyform' },
        ui.mnew ? el('span', { className: 'px field' }, el('input', { type: 'text', id: 'key-mnewcat', autocomplete: 'off', spellcheck: false, placeholder: 'New category', 'aria-label': 'New category', maxLength: 40,
          on: { keydown: (e) => { if (e.key === 'Enter') put(); else if (e.key === 'Escape') { e.stopPropagation(); ui.mnew = false; render('mcat'); } } } }))
          : choose('Category', [['', 'Pick a category', true], ...(ui.mview?.categories ?? []).map((c) => [JSON.stringify(c), c]), ['new', 'New category…']], ui.mcat ? JSON.stringify(ui.mcat) : '',
            (x) => { if (x === 'new') { ui.mnew = true; render('key-mnewcat'); } else ui.mcat = JSON.parse(x); }, 'mcat'),
        btn('Put in', put, { k: 'mput' }));
    return el('div', { className: 'mtools' }, pick,
      el('div', { className: 'links mlinks' },
        el('span', { className: 'usage', textContent: `${sel.length} selected` }),
        named.length ? link('Remove category', () => { askFirst(); moneyDo('unclassify', { ids: named.map((r) => r.id) }); clearSel(); render('find-money'); }, { k: 'munclass' }) : null,
        sel.length === 1 && sel[0].own ? link('Mark as mine', () => { moneyDo('own', { action: 'mark', key: sel[0].own }); clearSel(); render('find-money'); }, { k: 'mown', aria: `Mark ${sel[0].text} as your own account: its transfers stop counting` }) : null,
        sel.length === 1 && sel[0].manual ? link('Delete', () => { askFirst(); moneyDo('delete_entry', { id: sel[0].id }); clearSel(); render('find-money'); }, { k: 'mdel', danger: true, aria: `Delete ${sel[0].text}, added by hand` }) : null,
        link('Clear', () => { clearSel(); render('find-money'); }, { k: 'mclear', aria: 'Clear the selection' })));
  }
  // An expense or income no bank mail reported: what was typed stays while the panel is open.
  function entryForm() {
    const f = ui.mform, today = new Date().toLocaleDateString('en-CA');
    const save = () => {
      const amount = f.amount.trim(), description = f.description.trim();
      if (!/^\d{1,9}([.,]\d{1,2})?$/.test(amount) || !Number(amount.replace(',', '.'))) { note('Type the amount like 20.50.', true); return $('key-mamount')?.focus(); }
      if (!description) return $('key-mdesc')?.focus();
      moneyDo('add_entry', { kind: f.kind, amount, currency: f.currency, date: f.date || today, description, ...(f.kind === 'expense' && f.category ? { category: f.category } : {}) });
      f.amount = ''; f.description = ''; render('key-mamount');
    };
    const input = (key, props) => el('span', { className: `px field${key === 'date' ? ' mdate' : ''}` }, el('input', {
      autocomplete: 'off', spellcheck: false, value: f[key], ...props,
      on: { input: (e) => { f[key] = e.target.value; }, keydown: (e) => { if (e.key === 'Enter') save(); } },
    }));
    return group(f.kind === 'income' ? 'Add income' : 'Add an expense', 'What no bank mail tells me about: cash, another card, your salary.', null,
      picks('Kind', [['expense', 'Expense'], ['income', 'Income']], f.kind, (x) => { f.kind = x; render(`mkind:${x}`); }, 'mkind'),
      el('div', { className: 'keyform' },
        input('amount', { type: 'text', id: 'key-mamount', inputMode: 'decimal', placeholder: 'Amount, like 20.50', 'aria-label': 'Amount', maxLength: 13 }),
        picks('Currency', [['PEN', 'S/'], ['USD', 'US$']], f.currency, (x) => { f.currency = x; render(`mcur:${x}`); }, 'mcur')),
      el('div', { className: 'keyform' }, input('description', { type: 'text', id: 'key-mdesc', placeholder: f.kind === 'income' ? 'What, like Salary' : 'What or where, like Taxi', 'aria-label': 'Description', maxLength: 200 })),
      el('div', { className: 'keyform' },
        input('date', { type: 'date', id: 'key-mdate', value: f.date || today, 'aria-label': 'Date' }),
        f.kind === 'expense' ? choose('Category', [['', 'No category'], ...(ui.mview?.categories ?? []).map((c) => [c, c])], f.category, (x) => { f.category = x; }, 'mentrycat') : null),
      el('div', { className: 'links' }, btn('Add', save, { k: 'mentry-save' })));
  }
  // A table from the sidecar: kept unless the filters changed since it was asked for (a newer one is on its way).
  function takeMoney(v) {
    if (v.dropped !== undefined && ui.mq.category === v.dropped) ui.mq.category = undefined; // that category is gone
    const now = mquery();
    if (['month', 'category', 'group', 'text'].some((k) => (v.query?.[k] ?? '') !== (now[k] ?? ''))) return;
    ui.mview = v; ui.mpage = v.page; ui.masked = null;
    for (const id of ui.msel) if (!v.rows.some((r) => r.id === id)) ui.msel.delete(id);
    if (tab !== 'money') return;
    const f = ui.mfocus; ui.mfocus = null;
    if (document.activeElement?.id === 'find-money') refreshMoves(); else render(f ?? undefined);
  }
  // Searching redraws just the list and its footer, so the search field keeps its focus and caret.
  function refreshMoves() {
    const [panel, ft] = movesPage(), box = $('moves-box'), fresh = panel.querySelector?.('#moves-box');
    if (!box || !fresh) return render();
    box.replaceWith(fresh);
    const old = $('moves-foot');
    if (old && ft) old.replaceWith(ft); else if (old) old.remove(); else if (ft) $('moves-panel').after(ft);
    fit(); perCheck();
  }
  // As many rows as fit: when that changed, the page is asked for again at that size (from the same first row).
  function perCheck() {
    const v = ui.mview, per = movesPer();
    if (tab !== 'money' || ui.ytab !== 'moves' || !v || v.per === per || ui.masked === per) return;
    ui.masked = per; ui.mpage = Math.floor((v.page * v.per) / per); moneyAsk();
  }

  // Wayland: the commands to bind to keys in the desktop's settings (no app may hold its own shortcuts there).
  // A command shows only after copying it failed, so it can be copied by hand.
  const BIND_ROWS = [['talk', 'Talk to me'], ['summon', 'Show or hide me'], ['ask', 'Ask me'], ['list', 'Your list'], ['panel', 'This panel'], ['snap', 'Ask about an area']];
  function behaviorPage() {
    const b = state.bind;
    return [
      group('Behavior', 'What I may do, and when I start.', null,
        toggle('Sound effects', null, state.sound, () => act('sound'), 'sound'),
        toggle('Allow file edits and commands', 'Change files and run commands', state.actions, () => act('actions'), 'actions'),
        state.voice ? toggle('Auto-listen', state.voice.on ? 'Open the mic when I end on a question' : 'Needs Voice control on', state.voice.autoListen, () => act('autolisten'), 'autolisten') : null,
        state.login ? toggle('Open at login', null, state.login.on, () => act('login'), 'login') : null),
      b ? group('Shortcuts', 'Add these as custom shortcuts in your keyboard settings, with any keys you like.', null,
        BIND_ROWS.filter(([k]) => b[k]).map(([k, label]) => el('div', { className: 'setting' },
          el('span', {}, label, ui.bindShown.has(k) ? el('small', { className: 'cmd', textContent: b[k] }) : null),
          link('Copy', () => send({ type: 'copy_bind', which: k }), { k: `bind-${k}`, aria: `Copy the command for ${label.toLowerCase()}` })))) : null,
    ];
  }
  // Who made Roamies: Ken, live (he's drawn like the looks but isn't one), and where to find him.
  const KEN = [
    ['Skool', 'Learn with Ken, or support him', 'https://www.skool.com/kenkai', "Open Ken Kai's Skool community"],
    ['YouTube', '@kenkaidoesai', 'https://www.youtube.com/@kenkaidoesai', "Open Ken Kai's YouTube channel"],
    ['TikTok', '@ggkenkai', 'https://www.tiktok.com/@ggkenkai', "Open Ken Kai's TikTok"],
    ['Source code', 'Open source under AGPL-3.0', 'https://github.com/KenKaiii/Roamies', 'Open the Roamies source code on GitHub'],
  ];
  let ken = null;
  function maker() {
    if (!ken) {
      const cv = el('canvas', { 'aria-hidden': 'true' });
      const r = liveRoamie(cv, 100, 74, { look: 'ken', y: 0.55 });
      const card = el('div', { className: 'maker' }, cv, el('span', {}, 'Ken Kai', el('small', { textContent: 'Creator of Roamies' })));
      let waved = 0;
      card.addEventListener('pointerenter', () => { if (r && Date.now() - waved > 3500) { waved = Date.now(); r.act('wave'); } });
      r?.appear('crt');
      ken = card;
    }
    return ken;
  }
  function aboutPage() {
    return [
      group('Made by', null, null, maker(),
        KEN.map(([label, hint, url, aria]) => el('div', { className: 'setting' },
          el('span', {}, label, el('small', { textContent: hint })),
          link('Open', () => send({ type: 'open_link', url }), { k: `ken-${label.toLowerCase()}`, aria })))),
      group('Help', null, null,
        el('div', { className: 'links' },
          link('Setup guide', () => act('setup', true), { k: 'setup' }),
          link('Show logs', () => act('logs'), { k: 'logs' }),
          link('Save diagnostics', () => act('diagnostics'), { k: 'diagnostics', aria: 'Save a diagnostics file to send when something goes wrong' }))),
    ];
  }

  // ---------------------------------------------------------------- render
  const PANES = { home, memory, model: modelPage, appearance: appearancePage, voice: voicePage, money: moneyPage, behavior: behaviorPage, about: aboutPage };
  // focusKey: what to focus after (a data-k, or an element id); otherwise whatever had focus keeps it.
  function render(focusKey, animate = false) {
    if (!state) return;
    const active = document.activeElement;
    // Never rebuild under someone typing a key: catch up when they leave the field.
    if (!focusKey && !animate && active?.tagName === 'INPUT' && active.closest('.pane')) { deferred = true; return; }
    deferred = false;
    const keep = focusKey ?? active?.dataset?.k ?? (active?.id?.startsWith('key-') ? active.id : null);
    hideTip();
    const scroll = $('pane-' + tab).closest('.body').scrollTop;
    head();
    const pane = $(`pane-${tab}`);
    const draw = () => { pane.replaceChildren(...PANES[tab]().flat().filter(Boolean)); pane.classList.toggle('paged', !!pane.querySelector('.pagebox')); };
    draw();
    // Lists show as many rows as fit: drawn once to measure, again if a different number fits.
    if (fit()) draw();
    pane.closest('.body').scrollTop = scroll;
    // Rows fill in one after another (a page's worth; the rest come with the last), only when it opens or
    // the tab changes, never on the updates that arrive while it's open.
    pane.classList.toggle('enter', animate);
    if (animate) {
      let i = 0;
      for (const n of pane.children) { n.style.setProperty('--i', Math.min(i++, 10)); for (const li of n.querySelectorAll('.list > li')) li.style.setProperty('--i', Math.min(i++, 10)); }
      clearTimeout(render.t); render.t = setTimeout(() => pane.classList.remove('enter'), 600);
    }
    if (keep) (document.querySelector(`.pane [data-k="${CSS.escape(keep)}"]`) ?? document.getElementById(keep))?.focus();
    perCheck();
  }
  document.addEventListener('focusout', (e) => { if (deferred && e.target.tagName === 'INPUT') setTimeout(() => deferred && render(), 0); });
  // The window changes size with the screen it opens on: as many rows as fit there.
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && render(), 120); });

  let noteTimer = 0;
  function note(text, bad = false) {
    const n = $('note');
    n.textContent = text; n.title = text; n.className = `note${bad ? ' bad' : ''}`; n.hidden = false;
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, bad ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- sidebar and keys
  const TABS = Object.keys(PANES);
  const navi = (t) => $(`nav-${t}`);
  function show(name, focus = false) {
    if (!PANES[name]) name = name === 'settings' ? 'model' : 'home';
    const changed = name !== tab;
    if (!changed && !focus) return;
    tab = name;
    disarm(); ui.key = null;
    if (name === 'money') moneyAsk();
    for (const t of TABS) {
      if (t === name) navi(t).setAttribute('aria-current', 'page'); else navi(t).removeAttribute('aria-current');
      $(`pane-${t}`).hidden = t !== name;
    }
    $('pane-' + name).closest('.body').scrollTop = 0;
    render(null, changed);
    const t = navi(name);
    if (changed) { t.classList.remove('ping'); void t.offsetWidth; t.classList.add('ping'); }
    if (focus) t.focus();
  }
  document.querySelector('.side').addEventListener('animationend', (e) => e.target.classList.remove('ping'));
  for (const t of TABS) navi(t).addEventListener('click', () => show(t));
  // Up and down walk the sidebar (Home and End jump to its ends); Tab goes on into the page.
  document.querySelector('.side').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(e.target.dataset?.page);
    if (i < 0) return;
    const n = TABS.length;
    const j = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j], true); }
  });
  // Radio groups: arrows move the choice, like the setup guide's.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && tipFor) { e.preventDefault(); hideTip(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented && tab === 'money' && (ui.msel.size || ui.mren)) { clearSel(); ui.mren = false; render('find-money'); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) { const was = ui.arm; if (ui.key || disarm()) { ui.key = null; render(was ?? undefined); } else hide(); return; }
    const tl = e.target.closest?.('[role="tablist"]');
    if (tl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const all = [...tl.querySelectorAll('[role="tab"]')], i = all.indexOf(e.target);
      all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.click();
      return;
    }
    const g = e.target.closest?.('[role="radiogroup"]');
    if (!g || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(e.target);
    const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.click();
    // Focus follows the choice (the group may be redrawn when the new state arrives).
    const k = next?.dataset.k;
    if (k) { next.focus(); setTimeout(() => document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(), 200); }
  });
  // The recent list's "2m ago" stays true while it's open.
  setInterval(() => { if (tab === 'home' && !document.hidden) render(); }, 30000);

  // Switching on and off. main.rs calls these as it shows the window and before it hides it. One listener, and it
  // only acts on the animation that's playing now: a close cut short (the window hides on the last frame, which
  // pauses it) must never finish later and blank the panel it just reopened.
  const body = $('frame');
  body.addEventListener('animationend', (e) => {
    if (e.target !== body) return;
    if (e.animationName === 'crt-on' && body.classList.contains('opening')) body.classList.remove('opening');
    else if (e.animationName === 'crt-off' && body.classList.contains('shutting')) { body.classList.remove('shutting'); body.classList.add('shut'); }
  });
  window.__panelOpen = (fromBottom = false) => {
    body.classList.remove('shut', 'shutting', 'opening');
    // The Roamie switches on with the panel, and waves if it's been a while.
    if (avatar) { avatar.kit.vanish(null, true); setTimeout(() => { avatar.appear(); if (Date.now() - seen.opened > 10 * 60e3) setTimeout(() => avatar.act('wave'), 500); seen.opened = Date.now(); }, REDUCED.matches ? 0 : 120); }
    body.classList.toggle('from-bottom', !!fromBottom);
    if (REDUCED.matches) return render(null, false);
    void body.offsetWidth;
    body.classList.add('opening');
    render(null, true);
  };
  window.__panelShut = () => {
    disarm(); ui.key = null; unarmQuit();
    body.classList.remove('opening');
    if (REDUCED.matches) { body.classList.add('shut'); return; }
    body.classList.add('shutting');
  };
  // A click anywhere else puts an armed Confirm back.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('#head-quit')) unarmQuit();
    if (ui.arm && !e.target.closest?.('.arm[aria-pressed="true"]')) { disarm(); render(); }
  }, true);

  window.__panel = (m) => {
    if (m.kind === 'state') {
      const first = !state; state = m.state;
      // The Colors setting: on System the shell is asked for the desktop's scheme, now and every couple of seconds;
      // on Classic it is Classic. Only when the setting changed, so another update doesn't start the asking over.
      if (state.theme !== themed) { themed = state.theme; THEME?.follow(themed, () => invoke('theme_get')); }
      if (ui.arm && !document.querySelector(`[data-k="${CSS.escape(ui.arm)}"]`)) ui.arm = null;
      render(null, first);
      // Money's table may have changed with it (a mail read, the agent classifying): asked for again.
      if (tab === 'money') moneyAsk();
    }
    else if (m.kind === 'money') takeMoney(m.view);
    else if (m.kind === 'note') note(m.text, m.bad);
    else if (m.kind === 'copied') {
      if (!m.ok && state?.bind?.[m.which]) { ui.bindShown.add(m.which); render(`bind-${m.which}`); }
      note(m.ok ? 'Copied. Paste it into a new custom shortcut.' : "Couldn't copy it. Select the command and copy it instead.", !m.ok);
    }
  };
  send({ type: 'panel_open' });
  // The first show: the window was made hidden, so the switch-on is played here (main.rs's call may land
  // before this script has run).
  window.__panelOpen();

  // ---------------------------------------------------------------- browser preview
  function preview() {
    document.title = 'Roamies panel (preview with sample data)';
    const at = Date.now(), q = new URLSearchParams(location.search);
    // ?theme=light, dark or note: the desktop this preview pretends to have (note: the colours a light shell leaves
    // in its note). The Colors setting is then System and the shell's answer is that desktop's, as in the app.
    const DESK = { light: { light: true }, dark: { light: false }, note: { light: true, bg: '#f2e7de', surface: '#ffffff', fg: '#100a05', muted: '#786c61', line: '#e4d6cb', accent: '#9e6630', danger: '#d71921' } };
    const desk = DESK[q.get('theme')] ?? null;
    const s = {
      version: '0.9.0', os: /Win/.test(navigator.platform) ? 'win' : 'mac',
      status: { state: 'ready', text: 'Ready' }, busy: false, canNew: true,
      model: { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', providerLabel: 'Anthropic' },
      providers: [
        { id: 'anthropic', label: 'Anthropic', on: true, method: 'oauth', models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
        { id: 'openai', label: 'OpenAI', on: false, method: 'oauth', key: true, models: [] },
        { id: 'gemini', label: 'Gemini', on: false, method: 'key', models: [] },
        { id: 'moonshot', label: 'Kimi (Moonshot)', on: false, method: 'key', models: [], kinds: [
          { id: 'kimi-code', label: 'Kimi Code', billing: 'Uses your Kimi Code plan. Create the key in the Kimi Code Console.' },
          { id: 'moonshot', label: 'Moonshot', billing: 'Pay-per-token from platform.moonshot.ai.' }] },
        ...['xAI', 'GLM (Z.ai)', 'MiniMax', 'Xiaomi', 'DeepSeek', 'Sakana', 'OpenRouter', 'Hugging Face'].map((label) => ({ id: label.toLowerCase().replace(/\W/g, ''), label, on: false, method: 'key', models: [] })),
      ],
      loggingIn: null,
      recent: [
        { at: at - 20e3, kind: 'did', text: 'Saved to memory' },
        { at: at - 25e3, kind: 'did', text: 'Searched the web' },
        { at: at - 30e3, kind: 'ask', text: "what's a good name for the new release?" },
        { at: at - 9 * 60e3, kind: 'bad', text: "Couldn't finish: read budget.xlsx" },
        { at: at - 9.2 * 60e3, kind: 'did', text: 'Looked at your screen' },
        { at: at - 9.4 * 60e3, kind: 'ask', text: 'what does this error mean' },
      ],
      usage: { requests: 14, tokens: 31240 },
      facts: [{ id: 'f1', text: 'Prefers short answers in the morning' }, { id: 'f2', text: 'Working on the Roamies 1.0 launch, due end of month' }, { id: 'f3', text: 'Has a cat called Miso' }],
      commitments: [{ id: 'c1', text: 'Send the launch email', when: 'Fri 7 Nov, 10:00', overdue: false }, { id: 'c2', text: 'Book the dentist', when: 'Mon 3 Nov, 09:00', overdue: true }],
      name: 'Roamie', look: 'classic', looks: [['classic', 'Roamie'], ['jarvis', 'JARVIS'], ['anime', 'Anime Girl'], ['sarah', 'Sarah'], ['adrian', 'Adrian']],
      size: 'default', sizes: [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']],
      theme: desk ? 'system' : 'classic', themes: [['classic', 'Classic'], ['system', 'System']],
      replies: 'voice', fishKey: true, fishModel: 'drama-3', fishFree: false,
      language: 'auto', languages: [['auto', 'Auto'], ['en', 'English'], ['es', 'Español']],
      fishModels: [{ id: 'drama-3', name: 'Drama 3', perM: 50, promo: { perM: 10, until: '2026-12-01T08:00:00Z' } }, { id: 's2.1-pro', name: 'S2.1 Pro', perM: 15 }],
      voice: { on: true, keys: null, ready: true, mac: false, mute: true, download: null },
      // Linux's groups too, so every group of the Voice page can be seen here.
      duck: { on: true, level: 30, levels: [10, 20, 30, 50] }, wake: { on: true, phrase: 'oye jarvis' }, pen: { on: true },
      sound: true, actions: false, login: { on: true },
      update: { available: new URLSearchParams(location.search).has('update') ? '0.9.1' : null, installing: false, checking: false, result: null },
      intro: false,
      money: { accounts: [
        { id: 'mail-1', provider: 'yahoo', label: 'Yahoo', email: 'ana.perez@yahoo.com', status: { state: 'ok', text: 'Read 3 new bank mails', at: at - 4 * 60e3 } },
        { id: 'mail-2', provider: 'gmail', label: 'Gmail', email: 'ana.work@gmail.com', status: { state: 'error', text: 'Gmail refused the address or app password. Check the address, or create a new app password (it needs 2-Step Verification on).', at: at - 60e3 } },
      ], every: 5, everys: [2, 5, 15, 30, 60] },
    };
    if (q.has('busy')) Object.assign(s, { busy: true, status: { state: 'busy', text: 'Reading notes.md' } });
    if (q.has('empty')) Object.assign(s, { recent: [], facts: [], commitments: [], usage: null, money: { ...s.money, accounts: [] } });
    // Money's movements (made up), filtered and paged here as the sidecar does it (money/panel.mjs); changes only show
    // the table again. None with ?empty.
    const MOVES = q.has('empty') ? [] : [
      ['2026-11-10', 'Cafe Central', 'BCP', 'Purchase', 4550, 'PEN', 'Comida', 'Classified'], ['2026-11-10', 'Taxi', 'By hand', 'Purchase', 1800, 'PEN', 'Transporte', 'Classified'],
      ['2026-11-09', 'Jorge', 'BCP', 'Yape', 2500, 'PEN', null, 'Waiting', 'jorge'], ['2026-11-09', 'Ana Lopez', 'Banco Falabella', 'Own transfer', 30000, 'PEN', null, 'Not counted'],
      ['2026-11-08', 'Plaza Vea', 'BCP', 'Purchase', 120000, 'PEN', 'Supermercado', 'Classified'], ['2026-11-07', 'Bodega Sol', 'BCP', 'Purchase', 1500, 'PEN', null, 'Needs review'],
      ['2026-11-06', 'Netflix', 'BCP', 'Purchase', 999, 'USD', 'Entretenimiento', 'Classified'], ['2026-11-05', 'Luis Ramos', 'BCP', 'Received', 50000, 'PEN', null, 'Income', 'luis ramos'],
      ['2026-11-04', 'Tienda Max', 'BCP', 'Refused', 7000, 'PEN', null, 'Not counted'], ['2026-11-03', 'Mobile Pe', 'Banco Falabella', 'Transfer', 10000, 'PEN', null, 'Waiting', 'mobile pe'],
      ['2026-11-02', 'Farmacia Universal', 'BCP', 'Purchase', 3590, 'PEN', 'Salud', 'Classified'], ['2026-11-01', 'Sueldo', 'By hand', 'Income', 450000, 'PEN', null, 'Income'],
      ['2026-10-30', 'Cine Planet', 'BCP', 'Purchase', 4200, 'PEN', 'Entretenimiento', 'Classified'], ['2026-10-28', 'Grifo Primax', 'BCP', 'Purchase', 15000, 'PEN', 'Transporte', 'Classified'],
      ['2026-10-25', 'Wong', 'BCP', 'Purchase', 23480, 'PEN', 'Supermercado', 'Classified'], ['2026-10-20', 'Cafe Central', 'BCP', 'Purchase', 3000, 'PEN', 'Comida', 'Classified'],
    ].map(([date, text, source, kind, cents, currency, category, status, own = null], i, all) => ({
      id: all.length - i, date, time: '12:00', text, note: null, source, kind, cents, currency, category, status,
      amount: `${currency === 'USD' ? 'US$' : 'S/'} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      classifiable: status !== 'Income' && status !== 'Not counted', manual: source === 'By hand', own,
    }));
    const CATS = ['Comida', 'Supermercado', 'Transporte', 'Viajes', 'Servicios', 'Salud', 'Entretenimiento', 'Compras', 'Educación', 'Transferencias', 'Otros'];
    function moneyView({ query: f = {} }) {
      const words = (f.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hit = MOVES.filter((r) => (!f.month || r.date.startsWith(f.month))
        && (f.category === undefined || (f.category === null ? r.classifiable && !r.category : r.category === f.category))
        && (!f.group || f.group === 'all' || (f.group === 'spending' ? r.classifiable : f.group === 'income' ? r.status === 'Income' : r.status === 'Not counted'))
        && words.every((w) => r.text.toLowerCase().includes(w)));
      const per = f.per ?? 50, pages = Math.max(1, Math.ceil(hit.length / per)), page = Math.min(f.page ?? 0, pages - 1);
      const sum = (rows, cur) => `${cur === 'USD' ? 'US$' : 'S/'} ${(rows.reduce((n, r) => n + r.cents, 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      const totals = ['PEN', 'USD'].map((cur) => hit.filter((r) => r.currency === cur)).filter((of) => of.length)
        .map((of) => ({ currency: of[0].currency, spent: sum(of.filter((r) => r.classifiable), of[0].currency), received: sum(of.filter((r) => r.status === 'Income'), of[0].currency), count: of.length }));
      return { query: f, rows: hit.slice(page * per, page * per + per), total: hit.length, page, pages, per, totals,
        months: [...new Set(MOVES.map((r) => r.date.slice(0, 7)))], categories: CATS, own: q.has('empty') ? [] : [{ key: 'ana lopez', name: 'Ana Lopez', count: 3 }] };
    }
    if (q.has('many')) {
      const things = ['Prefers short answers', 'Drinks oat flat whites', 'Works late on Thursdays', 'Has a cat called Miso', 'Training for a 10k in March', 'Learning Japanese', 'Uses Figma for design', 'Ships on Fridays', 'Allergic to peanuts', 'Sister is called Ana'];
      s.facts = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: `${things[i % things.length]}${i >= things.length ? ` (${Math.floor(i / things.length) + 1})` : ''}` }));
      s.commitments = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, text: `Follow up on item ${i + 1}`, when: 'Fri 7 Nov, 10:00', overdue: i < 2 }));
      s.recent = Array.from({ length: 30 }, (_, i) => ({ ...s.recent[i % s.recent.length], at: at - i * 70e3 }));
    }
    if (q.has('checking')) s.update.checking = true;
    if (q.has('uptodate')) s.update.result = { ok: true, at: Date.now() + 60e3 };
    if (q.get('tab')) setTimeout(() => { if (q.get('mtab')) ui.mtab = q.get('mtab'); if (q.get('vtab')) ui.vtab = q.get('vtab'); if (q.get('atab')) ui.atab = q.get('atab'); if (q.get('ytab')) ui.ytab = q.get('ytab'); if (q.get('mprov')) ui.mprov = q.get('mprov'); show(q.get('tab')); }, 0);
    setTimeout(() => window.__panel({ kind: 'state', state: s }), 0);
    return async (cmd, args) => {
      if (cmd === 'theme_get') return desk;
      if (cmd !== 'sidecar_send') return null;
      console.log('[preview] would send', JSON.stringify(args.msg));
      if (args.msg?.type === 'panel_money') { setTimeout(() => window.__panel({ kind: 'money', view: moneyView(args.msg) }), 60); return null; }
      // A look change comes back as new state, as from the sidecar, so the Roamie's reaction can be seen.
      const id = args.msg?.id ?? '';
      if (id.startsWith('theme:')) { s.theme = id.slice(6); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('size:')) { s.size = id.slice(5); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('look:')) { s.look = id.slice(5); s.name = s.looks.find(([v]) => v === s.look)?.[1] ?? s.name; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      return null;
    };
  }
})();
