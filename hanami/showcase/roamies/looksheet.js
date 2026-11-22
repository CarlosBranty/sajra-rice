// Sprite sheets of the looks, for the native settings panel (Linux: glyph's Quickshell one), which can't run this
// drawing code. Each sheet is one look at one size, drawn exactly as the web panel's live tiles draw it (panel.js
// liveRoamie: the app's unit at half scale, the panel's LED kit, the colour scheme's dots and glow) into one PNG of
// FRAMES frames at 2x, transparent around it: a loop of it idling (breathing, blinking, eyes ahead) with one wave in
// the middle. The frames go left to right in rows of COLS (a single row would be wider than a GPU texture may be).
//
// Roamie.lookSheet(look, form) → { frames, columns, fps, width, height, scale, canvas } (width/height: one frame, px).
// Roamie.lookSig() → a short signature of what a sheet depends on (the colour scheme and this file's RENDER).
// In the Tauri overlay the shell calls window.__roamieLooks({ form, looks, have }) when the native panel asks for
// them (panel_socket.rs); have maps a look to the signature of the sheet the shell already holds. Every look comes
// back through the look_sheet command, with its PNG (base64) only when it had to be drawn again.
(() => {
  const R = window.Roamie;
  if (!R) return;
  // Bump when the drawing below changes, so sheets kept by the shell are drawn again.
  const RENDER = 1;
  // One frame: the web panel's look tile (104×76 CSS px), at 2x so every dot is crisp.
  const W = 104, H = 76, SCALE = 2, ZOOM = 0.5, UNIT = 340, Y = 0.55;
  // 8 s at 12 fps, simulated at 60 Hz (every 5th step drawn); the wave starts at 2.5 s and lasts 3.1 s.
  const FPS = 12, FRAMES = 96, COLS = 12, SUB = 5, WARM = 1.5, WAVE_AT = 2.5;

  R.lookSheet = (look, form = 'default') => {
    if (!R.ditherKit) return null;
    const w = W / ZOOM, h = H / ZOOM, dpr = SCALE, z = ZOOM;
    const env = {
      w, h, dpr, t: 0, unit: UNIT, transparent: true, spawn: { x: w / 2, y: h * Y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w * 1.6, y: h * Y, inside: true, active: true }, sleepy: 0, reduced: false,
    };
    let K = null;
    const kit = R.ditherKit({
      id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: () => 0.55 * R.theme.now.glow, speed: 80, pal: () => R.theme.now.led,
      // As the panel's tiles: no acts of its own, no pose.
      plugin: (k) => { K = k; return { busy: () => true, pose: () => null }; },
    }).create(env);
    // Drawn in one go, so nothing else runs meanwhile: no sounds of its own, and its mouth doesn't follow a reply
    // being spoken on the desktop.
    const sfx = R.sfx, voice = R.voiceOut;
    R.sfx = null; R.voiceOut = null;
    try {
      kit.setLook(look); kit.setForm(form); kit.resize(env);
      kit.mover.anchor = { x: w / 2, y: h * Y, r: 1.5 };
      const frame = document.createElement('canvas');
      frame.width = W * SCALE; frame.height = H * SCALE;
      const fc = frame.getContext('2d');
      const strip = document.createElement('canvas');
      strip.width = frame.width * COLS; strip.height = frame.height * Math.ceil(FRAMES / COLS);
      const sc = strip.getContext('2d');
      const dt = 1 / (FPS * SUB);
      const step = () => { env.t += dt; kit.update(dt, env); };
      for (let i = 0; i < WARM / dt; i++) step();
      let waved = false;
      for (let f = 0; f < FRAMES; f++) {
        for (let s = 0; s < SUB; s++) {
          if (!waved && f / FPS >= WAVE_AT) { waved = true; K?.startAct('wave'); }
          step();
        }
        fc.setTransform(1, 0, 0, 1, 0, 0); fc.clearRect(0, 0, frame.width, frame.height);
        fc.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        fc.save(); kit.draw(fc, env); fc.restore();
        sc.drawImage(frame, (f % COLS) * frame.width, Math.floor(f / COLS) * frame.height);
      }
      return { frames: FRAMES, columns: COLS, fps: FPS, width: frame.width, height: frame.height, scale: SCALE, canvas: strip };
    } finally {
      R.sfx = sfx; R.voiceOut = voice;
    }
  };

  // What a sheet depends on besides its look and size: the colours and this renderer.
  R.lookSig = () => {
    const s = JSON.stringify([RENDER, R.theme?.now?.led ?? null, R.theme?.now?.glow ?? null]);
    let a = 5381;
    for (let i = 0; i < s.length; i++) a = ((a * 33) ^ s.charCodeAt(i)) >>> 0;
    return a.toString(36);
  };

  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  // One request at a time, each look after the last (a yield between them, so the Roamie on screen doesn't stall).
  let queue = Promise.resolve();
  window.__roamieLooks = ({ form, looks, have = {} } = {}) => {
    queue = queue.then(async () => {
      const sig = R.lookSig();
      for (const look of looks ?? []) {
        await new Promise((r) => setTimeout(r, 0));
        const args = { look, form, sig, frames: FRAMES, columns: COLS, fps: FPS, width: W * SCALE, height: H * SCALE, png: null };
        if (have[look] !== sig) {
          const out = R.lookSheet(look, form);
          if (!out) return;
          args.png = out.canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
        }
        await invoke('look_sheet', args).catch(() => {});
      }
    }).catch(() => {});
  };
})();
