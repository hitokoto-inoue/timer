(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  const timeEl = $("#time");
  const clockEl = $("#clock");
  const minuteHand = $("#hand-minute");
  const secondHand = $("#hand-second");
  const minutesEl = $("#minutes");
  const secondsEl = $("#seconds");
  const setBtn = $("#set-btn");
  const startBtn = $("#start-btn");
  const pauseBtn = $("#pause-btn");
  const resetBtn = $("#reset-btn");
  const form = $("#time-form");

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

  function formatMMSS(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // Audio engine for ticks and end beep (single shared AudioContext)
  const audio = (() => {
    let ctx = null;
    function getCtx() {
      try {
        if (ctx && ctx.state === "closed") ctx = null;
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          ctx = new AC();
        }
        return ctx;
      } catch { return null; }
    }
    async function resume() {
      const c = getCtx();
      if (!c) return;
      if (c.state === "suspended") {
        try { await c.resume(); } catch {}
      }
    }
    function click({ t = 0, freq = 1100, dur = 0.03, gain = 0.18 } = {}) {
      const c = getCtx();
      if (!c) return;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = "square";
      o.frequency.value = freq;
      o.connect(g);
      g.connect(c.destination);
      const now = c.currentTime;
      const startAt = now + t;
      g.gain.setValueAtTime(0.0001, startAt);
      g.gain.exponentialRampToValueAtTime(gain, startAt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
      o.start(startAt);
      o.stop(startAt + dur + 0.01);
    }
    function tick(parity = false) {
      // alternate pitch for a subtle tick-tock
      click({ freq: parity ? 900 : 1200, dur: 0.025, gain: 0.14 });
    }
    function beepEnd() {
      const c = getCtx();
      if (!c) return;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      o.connect(g);
      g.connect(c.destination);
      const now = c.currentTime;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      o.start(now);
      o.stop(now + 0.8);
    }
    return { resume, tick, beepEnd };
  })();

  class CountdownTimer {
    constructor() {
      this.initialMs = 0; // set duration
      this.remainingMs = 0;
      this.endTime = 0;
      this.raf = null;
      this.state = "idle"; // idle | running | paused | finished
      this._boundTick = this._tick.bind(this);
      this._lastWholeSec = null; // track second boundary for ticking
      this._tickParity = false;  // alternate tick/tock
    }

    set(ms) {
      this.initialMs = Math.max(0, Math.floor(ms));
      this.remainingMs = this.initialMs;
      this.state = this.initialMs > 0 ? "paused" : "idle";
      this._updateDisplay();
      this._updateTitle();
    }

    start() {
      if (this.state === "running") return;
      if (this.remainingMs <= 0) return; // nothing to run
      this.endTime = performance.now() + this.remainingMs;
      // prepare tick boundary and audio
      this._lastWholeSec = Math.ceil(this.remainingMs / 1000);
      this._tickParity = false;
      audio.resume();
      this.state = "running";
      this._loop();
    }

    pause() {
      if (this.state !== "running") return;
      this._cancelLoop();
      this.remainingMs = Math.max(0, this.endTime - performance.now());
      this.state = this.remainingMs > 0 ? "paused" : "finished";
      this._updateUIState();
      this._updateTitle();
    }

    reset() {
      this._cancelLoop();
      this.remainingMs = this.initialMs;
      this.state = this.initialMs > 0 ? "paused" : "idle";
      this._updateDisplay();
      this._updateUIState();
      this._updateTitle();
    }

    _loop() {
      this._updateUIState();
      this._updateTitle();
      if (!this.raf) this.raf = requestAnimationFrame(this._boundTick);
    }

    _tick() {
      this.raf = null;
      const now = performance.now();
      const remaining = Math.max(0, this.endTime - now);
      this.remainingMs = remaining;
      // Tick when crossing each whole-second boundary
      const currWhole = Math.ceil(remaining / 1000);
      if (this._lastWholeSec != null && currWhole < this._lastWholeSec) {
        audio.tick(this._tickParity);
        this._tickParity = !this._tickParity;
      }
      this._lastWholeSec = currWhole;
      this._updateDisplay();

      if (remaining <= 0) {
        this.state = "finished";
        this._updateUIState();
        this._updateTitle();
        audio.beepEnd();
        return;
      }
      this._loop();
    }

    _cancelLoop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } }

    _updateDisplay() {
      // Update SR-only numeric text for accessibility
      timeEl.textContent = formatMMSS(this.remainingMs);
      timeEl.setAttribute("aria-label", `残り時間 ${timeEl.textContent}`);

      // Update analog face (hands + progress ring)
      this._updateAnalog();
    }

    _updateAnalog() {
      if (!clockEl) return;
      const initial = Math.max(0, this.initialMs);
      const remaining = Math.max(0, this.remainingMs);
      const elapsed = Math.max(0, initial - remaining);

      // Progress ring (remaining fraction)
      const p = initial > 0 ? remaining / initial : 0;
      clockEl.style.setProperty("--p", String(p));

      // Hands: show elapsed time modulo 60m/60s so hands sweep clockwise
      const sec = (elapsed / 1000) % 60; // fractional seconds elapsed in current minute
      const min = (elapsed / 60000) % 60; // fractional minutes elapsed in current hour

      if (secondHand) {
        const sDeg = (sec / 60) * 360;
        secondHand.style.transform = `rotate(${sDeg}deg)`;
      }
      if (minuteHand) {
        const mDeg = (min / 60) * 360;
        minuteHand.style.transform = `rotate(${mDeg}deg)`;
      }
    }

    _updateUIState() {
      const running = this.state === "running";
      const hasSet = this.initialMs > 0;
      startBtn.disabled = running || !hasSet || this.remainingMs <= 0;
      pauseBtn.disabled = !running;
      resetBtn.disabled = !hasSet || (this.remainingMs === this.initialMs && this.state !== "running");
      minutesEl.disabled = running;
      secondsEl.disabled = running;
    }

    _updateTitle() {
      const base = "Timer";
      if (this.state === "running") {
        document.title = `${formatMMSS(this.remainingMs)} • ${base}`;
      } else {
        document.title = base;
      }
    }
  }

  const timer = new CountdownTimer();

  // Persist last inputs
  const LS_KEY = "timer:last";
  function loadLast() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const { m, s } = JSON.parse(raw);
      if (Number.isFinite(m)) minutesEl.value = String(m);
      if (Number.isFinite(s)) secondsEl.value = String(s);
    } catch {}
  }
  function saveLast() {
    try {
      const m = Number(minutesEl.value || 0);
      const s = Number(secondsEl.value || 0);
      localStorage.setItem(LS_KEY, JSON.stringify({ m, s }));
    } catch {}
  }

  function readInputsToMs() {
    const m = clamp(Number(minutesEl.value || 0), 0, 999);
    const s = clamp(Number(secondsEl.value || 0), 0, 59);
    return (m * 60 + s) * 1000;
  }

  function applySet() {
    const ms = readInputsToMs();
    timer.set(ms);
    timer._updateUIState();
    saveLast();
  }

  // Events
  form.addEventListener("submit", (e) => { e.preventDefault(); applySet(); });
  startBtn.addEventListener("click", () => timer.start());
  pauseBtn.addEventListener("click", () => timer.pause());
  resetBtn.addEventListener("click", () => timer.reset());

  // Keyboard shortcuts: Space = start/pause, R = reset, Enter = set
  window.addEventListener("keydown", (e) => {
    // Prevent Space scrolling when focused on body
    if (e.code === "Space") e.preventDefault();
  }, { passive: false });

  window.addEventListener("keyup", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable;
    if (inInput) return; // avoid interfering with typing

    if (e.code === "Space") {
      if (timer.state === "running") timer.pause(); else timer.start();
    } else if (e.key.toLowerCase() === "r") {
      timer.reset();
    } else if (e.key === "Enter") {
      applySet();
    }
  });

  // Initialize
  loadLast();
  applySet();
})();
