// Phone link client. tools/phonelink.py injects this into index.html; the
// GitHub Pages build never loads it. It reports console output, errors, the
// device and a heartbeat to the server, and runs code the server sends
// (which only this PC can queue). A small dot in the corner shows the link.
(() => {
  const ID = Math.random().toString(36).slice(2, 7);
  const queue = [];
  let timer = 0;
  let linked = true;

  function fmt(v, depth = 0) {
    if (v instanceof Error) {
      const head = `${v.name}: ${v.message}`;
      return v.stack ? (v.stack.startsWith(head) ? v.stack : head + '\n' + v.stack) : head;
    }
    if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
    if (v === undefined || typeof v === 'function') return String(v);
    if (ArrayBuffer.isView(v)) return Array.from(v.slice(0, 64)).map((x) => +(+x).toPrecision(5));
    try {
      const s = JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? Array.from(x.slice(0, 64)) : x));
      return s && s.length > 4000 ? s.slice(0, 4000) + '…' : s === undefined ? String(v) : JSON.parse(s);
    } catch {
      return String(v);
    }
  }

  function send(type, data) {
    queue.push({ t: Date.now(), type, data });
    if (queue.length > 400) queue.splice(0, queue.length - 400);
    if (!timer) timer = setTimeout(flush, 300);
  }

  async function flush() {
    timer = 0;
    if (!queue.length) return;
    const entries = queue.splice(0, queue.length);
    try {
      const r = await fetch('/__link/log', {
        method: 'POST', keepalive: entries.length < 40,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: ID, entries }),
      });
      if (!r.ok) throw new Error(r.status);
      setLinked(true);
    } catch {
      queue.unshift(...entries);
      setLinked(false);
      timer = setTimeout(flush, 2000);
    }
  }

  // ------------------------------------------------------------ console and errors

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = function (...args) {
      try { send('console', { level, args: args.map((a) => fmt(a)) }); } catch { /* never break the page */ }
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) {
      send('load-error', { tag: e.target.tagName, src: e.target.src || e.target.href });
    } else {
      send('error', { msg: e.message, at: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error && e.error.stack });
    }
  }, true);
  window.addEventListener('unhandledrejection', (e) => send('rejection', { reason: fmt(e.reason) }));

  // ------------------------------------------------------------ device

  function device() {
    const info = {
      ua: navigator.userAgent,
      screen: [screen.width, screen.height], dpr: devicePixelRatio,
      inner: [innerWidth, innerHeight],
      orientation: screen.orientation && screen.orientation.type,
      cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
      secure: isSecureContext, camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      net: navigator.connection && navigator.connection.effectiveType,
    };
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        info.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        info.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        info.ext = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear',
          'EXT_float_blend'].filter((x) => gl.getExtension(x));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      } else info.gpu = 'no webgl2';
    } catch (e) { info.gpu = 'error ' + e.message; }
    return info;
  }
  send('hello', device());

  // ------------------------------------------------------------ heartbeat

  let frames = 0;
  let worst = 0;
  let last = performance.now();
  (function count(t) {
    frames++;
    worst = Math.max(worst, t - last);
    last = t;
    requestAnimationFrame(count);
  })(performance.now());
  setInterval(() => {
    const stat = document.getElementById('stat');
    send('beat', {
      fps: frames / 2, worstMs: Math.round(worst), vis: document.visibilityState,
      inner: [innerWidth, innerHeight], stat: stat ? stat.textContent : null,
    });
    frames = 0;
    worst = 0;
  }, 2000);

  // ------------------------------------------------------------ commands

  const helpers = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    $: (sel) => document.querySelector(sel),
    // Set a panel control the way a person would, so the app's listeners run.
    set(id, value) {
      const el = document.getElementById(id);
      if (el.type === 'checkbox') el.checked = !!value; else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.type === 'checkbox' ? el.checked : el.value;
    },
    // Screenshot of the WebGL canvas, taken in the frame right after the app
    // draws (a hidden page draws no frames, so then it is taken straight away).
    async snap(name = 'snap', maxSide = 900) {
      const stage = document.getElementById('stage');
      const grab = () => {
        const k = Math.min(1, maxSide / Math.max(stage.width, stage.height));
        const c = document.createElement('canvas');
        c.width = Math.round(stage.width * k);
        c.height = Math.round(stage.height * k);
        c.getContext('2d').drawImage(stage, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.8);
      };
      const url = await new Promise((resolve) => {
        let done = false;
        const once = () => { if (!done) { done = true; resolve(grab()); } };
        requestAnimationFrame(once);
        setTimeout(once, 400);
      });
      const r = await fetch(`/__link/snap?client=${ID}&name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
      return (await r.json()).path;
    },
  };
  const AsyncFunction = (async () => {}).constructor;
  const names = Object.keys(helpers);

  async function runOne(cmd) {
    let fn;
    try {
      fn = new AsyncFunction(...names, `return (${cmd.code}\n)`); // an expression
    } catch {
      fn = new AsyncFunction(...names, cmd.code); // a body with its own return
    }
    try {
      const value = await fn(...names.map((n) => helpers[n]));
      send('result', { id: cmd.id, ok: true, value: fmt(value) });
    } catch (e) {
      send('result', { id: cmd.id, ok: false, error: fmt(e) });
    }
  }

  let after = 0;
  (async function poll() {
    for (;;) {
      try {
        const r = await fetch(`/__link/cmd?client=${ID}&after=${after}`);
        const cmds = await r.json();
        for (const cmd of cmds) {
          after = Math.max(after, cmd.id);
          runOne(cmd);
        }
        setLinked(true);
      } catch {
        setLinked(false);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  // ------------------------------------------------------------ the dot

  let dot = null;
  function setLinked(on) {
    linked = on;
    if (dot) dot.style.background = on ? '#3ddc84' : '#e04848';
  }
  document.addEventListener('DOMContentLoaded', () => {
    dot = document.createElement('div');
    dot.title = 'phone link ' + ID;
    dot.style.cssText = 'position:fixed;left:6px;bottom:6px;width:8px;height:8px;border-radius:50%;' +
      'z-index:99999;pointer-events:none;opacity:0.8;background:#3ddc84';
    document.body.appendChild(dot);
    setLinked(linked);
  });
})();
