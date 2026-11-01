// Prozedurale Sounds mit WebAudio (keine Dateien noetig).
// Aufbau: Quellen -> (Panner) -> dry + Hall (Convolver) + Tal-Echo (Multi-Tap) -> Daempfung -> Kompressor -> Ausgang

type V3 = { x: number; y: number; z: number };
export type ImpactSound = 'erde' | 'stein' | 'holz' | 'metall' | 'blaetter' | 'koerper';

export class Audio {
  ctx: AudioContext | null = null;
  private out!: GainNode; // vor der Daempfung
  private master?: GainNode;
  volume = 0.8;
  private muffleF!: BiquadFilterNode;
  private reverb!: ConvolverNode;
  private reverbIn!: GainNode;
  private echoIn!: GainNode;
  private noise!: AudioBuffer;
  private pink!: AudioBuffer;
  private shaper!: WaveShaperNode;
  private windA?: { g: GainNode; f: BiquadFilterNode };
  private windB?: { g: GainNode; f: BiquadFilterNode };
  private rainG?: GainNode;
  private birdsOn = false;
  private nextBird = 0;
  private nextBeat = 0;
  private listener = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };
  heartRate = 70;
  heartVolume = 0;
  breathing = 0; // 0..1 schweres Atmen nach dem Sprint

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.25;
    const master = ctx.createGain();
    master.gain.value = this.volume;
    this.master = master;
    this.muffleF = ctx.createBiquadFilter();
    this.muffleF.type = 'lowpass';
    this.muffleF.frequency.value = 20000;
    this.out = ctx.createGain();
    this.out.connect(this.muffleF).connect(comp).connect(master).connect(ctx.destination);

    // Rauschpuffer (weiss + rosa)
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    this.pink = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.noise.getChannelData(0), p = this.pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0;
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1;
      w[i] = r;
      b0 = 0.99886 * b0 + r * 0.0555179; b1 = 0.99332 * b1 + r * 0.0750759; b2 = 0.969 * b2 + r * 0.153852;
      b3 = 0.8665 * b3 + r * 0.3104856; b4 = 0.55 * b4 + r * 0.5329522; b5 = -0.7616 * b5 - r * 0.016898;
      p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + r * 0.5362) * 0.11;
    }

    // Hall: synthetische Impulsantwort einer offenen Berglandschaft
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(3.2, 2.6);
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 1;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.55;
    this.reverbIn.connect(this.reverb).connect(revOut).connect(this.out);

    // Tal-Echo: drei Reflexionen von verschiedenen Haengen, links/rechts verteilt
    this.echoIn = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    this.echoIn.connect(lp);
    for (const [t, g, pan] of [[0.62, 0.32, -0.6], [1.15, 0.22, 0.7], [1.9, 0.13, -0.2], [2.7, 0.07, 0.4]] as const) {
      const d = ctx.createDelay(4);
      d.delayTime.value = t;
      const gg = ctx.createGain();
      gg.gain.value = g;
      const pn = ctx.createStereoPanner();
      pn.pan.value = pan;
      lp.connect(d).connect(gg).connect(pn);
      pn.connect(this.out);
      pn.connect(this.reverbIn);
    }

    // Leichte Saettigung fuer Wucht
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    this.shaper.curve = curve;
    this.shaper.connect(this.out);

    this.startWind();
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        // spaerliche fruehe Reflexionen, dann diffuser Nachhall
        const early = t < 0.25 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 0.8 : 0;
        d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t / seconds, decay) * (t < 0.08 ? t / 0.08 : 1)) * 0.5 + early;
      }
    }
    return buf;
  }

  // ------------------------------------------------------------ Hilfen

  private src(pink = false): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = pink ? this.pink : this.noise;
    s.loopStart = 0;
    return s;
  }

  private env(g: GainNode | AudioParam, t: number, peak: number, attack: number, decay: number) {
    const p = 'gain' in g ? g.gain : g;
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /** Ausgang fuer eine Quelle: Stereo-Position + Hall-/Echo-Anteil. */
  private bus(pan = 0, reverb = 0.2, echo = 0, dry = 1): GainNode {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const pn = ctx.createStereoPanner();
    pn.pan.value = Math.max(-1, Math.min(1, pan));
    input.connect(pn);
    const d = ctx.createGain();
    d.gain.value = dry;
    pn.connect(d).connect(this.out);
    if (reverb > 0) {
      const r = ctx.createGain();
      r.gain.value = reverb;
      pn.connect(r).connect(this.reverbIn);
    }
    if (echo > 0) {
      const e = ctx.createGain();
      e.gain.value = echo;
      pn.connect(e).connect(this.echoIn);
    }
    return input;
  }

  private panFor(pos?: V3): number {
    if (!pos) return 0;
    const L = this.listener;
    const dx = pos.x - L.x, dz = pos.z - L.z;
    const len = Math.hypot(dx, dz) || 1;
    // rechts = (-fz, fx)
    return ((dx * -L.fz + dz * L.fx) / len) * 0.85;
  }

  /** Gefiltertes Rauschen als kurzer Klang. */
  private burst(dest: AudioNode, t: number, opts: { type: BiquadFilterType; freq: number; q?: number; peak: number; attack?: number; decay: number; sweepTo?: number; pink?: boolean }) {
    const ctx = this.ctx!;
    const s = this.src(opts.pink);
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + opts.decay);
    f.Q.value = opts.q ?? 0.7;
    const g = ctx.createGain();
    this.env(g, t, opts.peak, opts.attack ?? 0.001, opts.decay);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 1.2);
    s.stop(t + (opts.attack ?? 0.001) + opts.decay + 0.05);
  }

  private tone(dest: AudioNode, t: number, freq: number, to: number, peak: number, decay: number, type: OscillatorType = 'sine', attack = 0.002) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to !== freq) o.frequency.exponentialRampToValueAtTime(to, t + decay);
    const g = ctx.createGain();
    this.env(g, t, peak, attack, decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  // ------------------------------------------------------------ Welt

  setVolume(v: number) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setListener(pos: V3, forward: V3) {
    const len = Math.hypot(forward.x, forward.z) || 1;
    this.listener = { x: pos.x, y: pos.y, z: pos.z, fx: forward.x / len, fz: forward.z / len };
  }

  private startWind() {
    const ctx = this.ctx!;
    const mk = (type: BiquadFilterType, f: number, q: number) => {
      const s = this.src(true);
      s.loop = true;
      const flt = ctx.createBiquadFilter();
      flt.type = type;
      flt.frequency.value = f;
      flt.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      s.connect(flt).connect(g).connect(this.out);
      s.start(0, Math.random() * 2);
      return { g, f: flt };
    };
    this.windA = mk('lowpass', 350, 0.5); // Grundrauschen
    this.windB = mk('bandpass', 900, 3); // Pfeifen in Boeen
  }

  setWind(speed: number, gust: number) {
    if (!this.ctx || !this.windA || !this.windB) return;
    const t = this.ctx.currentTime;
    this.windA.g.gain.setTargetAtTime(0.05 + speed * 0.022 * (0.6 + gust * 0.8), t, 0.5);
    this.windA.f.frequency.setTargetAtTime(220 + speed * 30 + gust * 180, t, 0.6);
    this.windB.g.gain.setTargetAtTime(Math.max(0, speed - 4) * 0.006 * gust, t, 0.7);
    this.windB.f.frequency.setTargetAtTime(600 + speed * 60 + gust * 500, t, 0.8);
  }

  /** Umgebung zur Runde: Voegel bei schoenem Wetter, Regen bei Regen. */
  ambience(weather: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.birdsOn = weather === 'klar' || weather === 'dunst';
    this.nextBird = ctx.currentTime + 2;
    if (this.rainG) {
      this.rainG.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    }
    if (weather === 'regen') {
      if (!this.rainG) {
        const s = this.src();
        s.loop = true;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1200;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 9000;
        this.rainG = ctx.createGain();
        this.rainG.gain.value = 0;
        s.connect(hp).connect(lp).connect(this.rainG).connect(this.out);
        s.start();
      }
      this.rainG.gain.setTargetAtTime(0.09, ctx.currentTime, 1);
    }
    this.muffle(false);
  }

  private bird(t: number) {
    const ctx = this.ctx!;
    const dest = this.bus(Math.random() * 1.6 - 0.8, 0.5, 0, 0.6);
    const base = 2600 + Math.random() * 2200;
    const notes = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < notes; i++) {
      const tt = t + i * (0.09 + Math.random() * 0.08);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.25), tt);
      o.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.6), tt + 0.07);
      this.env(g, tt, 0.018 + Math.random() * 0.02, 0.01, 0.07);
      o.connect(g).connect(dest);
      o.start(tt);
      o.stop(tt + 0.12);
    }
  }

  // ------------------------------------------------------------ Waffe

  /** Eigener Schuss: Knall, Druckwelle, Mechanik, Hall und Echo im Tal. */
  playerShot() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = this.bus(0, 0.9, 1.0, 1);
    const punch = ctx.createGain();
    punch.gain.value = 1;
    punch.connect(this.shaper);
    // Transiente
    this.burst(punch, t, { type: 'highpass', freq: 2500, peak: 1.4, decay: 0.012 });
    // Knallkoerper
    this.burst(punch, t, { type: 'lowpass', freq: 9000, sweepTo: 260, peak: 1.6, decay: 0.38 });
    this.burst(dest, t, { type: 'bandpass', freq: 1200, q: 0.8, peak: 0.9, decay: 0.22, pink: true });
    // Druck / Tiefton
    this.tone(punch, t, 95, 32, 1.5, 0.32);
    this.tone(punch, t, 55, 28, 1.0, 0.45);
    // Mechanik: Schlagbolzen
    this.burst(dest, t, { type: 'bandpass', freq: 4200, q: 6, peak: 0.25, decay: 0.03 });
    // Nachhall der Druckwelle durchs Tal
    this.burst(dest, t + 0.02, { type: 'lowpass', freq: 700, sweepTo: 150, peak: 0.35, attack: 0.04, decay: 1.6, pink: true });
  }

  /** Entfernter Schuss: Ueberschallknall frueher (wenn auf dich), Muendungsknall spaeter. */
  distantShot(distance: number, towardPlayer: boolean, pos?: V3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const pan = this.panFor(pos);
    const vol = 1.4 / (1 + distance / 180);
    if (towardPlayer) {
      // N-Welle: sehr kurzer, harter Peitschenknall
      const tc = t0 + distance / 720;
      const crack = this.bus(pan * 0.4, 0.4, 0.2, 1);
      this.burst(crack, tc, { type: 'highpass', freq: 3000, peak: 1.1, decay: 0.006 });
      this.burst(crack, tc + 0.004, { type: 'bandpass', freq: 5200, q: 2, peak: 0.5, decay: 0.05 });
    }
    const tb = t0 + distance / 343;
    const dest = this.bus(pan, 1.2, 1.2, 0.9);
    this.burst(dest, tb, { type: 'lowpass', freq: Math.max(500, 3200 - distance * 3), sweepTo: 180, peak: vol, attack: 0.008, decay: 0.7, pink: true });
    this.tone(dest, tb, 70, 35, vol * 0.8, 0.5);
  }

  /** Repetieren: Kammer auf, zurueck (Huelse fliegt), vor, zu. */
  bolt(volume = 0.5, delay = 0, pos?: V3) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const dest = this.bus(this.panFor(pos), 0.15, 0, 1);
    const click = (tt: number, f: number, v: number) => {
      this.burst(dest, tt, { type: 'bandpass', freq: f, q: 12, peak: v, decay: 0.035 });
      this.burst(dest, tt, { type: 'highpass', freq: 5000, peak: v * 0.6, decay: 0.008 });
    };
    const slide = (tt: number, f: number, v: number, dur: number) => this.burst(dest, tt, { type: 'bandpass', freq: f, q: 3, peak: v * 0.35, attack: 0.02, decay: dur, sweepTo: f * 1.3 });
    click(t, 2300, volume);
    slide(t + 0.06, 1700, volume, 0.12);
    click(t + 0.2, 3100, volume * 0.8);
    slide(t + 0.42, 1500, volume, 0.1);
    click(t + 0.56, 2000, volume);
    this.burst(dest, t + 0.58, { type: 'lowpass', freq: 900, peak: volume * 0.5, decay: 0.05 });
    click(t + 0.7, 2600, volume * 0.9);
    if (volume > 0.3) this.casing(t + 0.75);
  }

  /** Messinghuelse faellt ins Gras / auf Stein. */
  private casing(t: number) {
    const dest = this.bus(0.25, 0.1, 0, 1);
    for (let i = 0; i < 3; i++) {
      const tt = t + i * (0.09 + Math.random() * 0.05);
      const v = 0.07 / (i + 1);
      for (const f of [4200, 6100, 7900]) this.tone(dest, tt, f * (0.97 + Math.random() * 0.06), f, v, 0.12 - i * 0.03, 'sine', 0.001);
    }
  }

  reload() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.bus(0.15, 0.1, 0, 1);
    this.burst(dest, t, { type: 'bandpass', freq: 1800, q: 8, peak: 0.25, decay: 0.04 }); // Magazin raus
    this.burst(dest, t + 0.05, { type: 'bandpass', freq: 600, q: 2, peak: 0.15, decay: 0.15, attack: 0.03 }); // Stoff/Tasche
    for (let i = 0; i < 4; i++) this.burst(dest, t + 0.8 + i * 0.22, { type: 'bandpass', freq: 3000, q: 10, peak: 0.12, decay: 0.03 }); // Patronen
    this.burst(dest, t + 1.9, { type: 'bandpass', freq: 1500, q: 6, peak: 0.35, decay: 0.05 }); // Magazin rein
    this.burst(dest, t + 1.92, { type: 'lowpass', freq: 500, peak: 0.25, decay: 0.06 });
  }

  dryClick() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(this.bus(0, 0.05), t, { type: 'bandpass', freq: 3500, q: 10, peak: 0.35, decay: 0.03 });
  }

  zoomTick() {
    if (!this.ctx) return;
    this.burst(this.bus(0, 0), this.ctx.currentTime, { type: 'bandpass', freq: 5200, q: 14, peak: 0.06, decay: 0.015 });
  }

  // ------------------------------------------------------------ Einschlaege

  impact(kind: ImpactSound, distance: number, pos?: V3) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + distance / 343;
    const vol = Math.min(1.3, 3.2 / (1 + distance / 5));
    if (vol < 0.008) return;
    const dest = this.bus(this.panFor(pos), 0.5, distance > 30 ? 0.4 : 0, 1);
    switch (kind) {
      case 'erde':
        this.burst(dest, t, { type: 'lowpass', freq: 900, peak: vol, decay: 0.12, pink: true });
        this.tone(dest, t, 110, 50, vol * 0.6, 0.12);
        this.burst(dest, t + 0.02, { type: 'highpass', freq: 2500, peak: vol * 0.15, attack: 0.02, decay: 0.3 }); // Erdspritzer
        break;
      case 'stein':
        this.burst(dest, t, { type: 'highpass', freq: 2000, peak: vol, decay: 0.03 });
        this.burst(dest, t, { type: 'bandpass', freq: 3200, q: 4, peak: vol * 0.5, decay: 0.12 });
        if (Math.random() < 0.6) this.ricochet(dest, t + 0.02, vol);
        break;
      case 'holz':
        this.burst(dest, t, { type: 'bandpass', freq: 750, q: 5, peak: vol, decay: 0.09 });
        this.tone(dest, t, 240, 180, vol * 0.5, 0.1, 'triangle');
        this.burst(dest, t + 0.01, { type: 'highpass', freq: 3000, peak: vol * 0.2, decay: 0.15 }); // Splitter
        break;
      case 'metall':
        for (const f of [880, 1370, 2210, 3170]) this.tone(dest, t, f, f * 0.98, vol * 0.3, 0.6 + Math.random() * 0.4, 'sine', 0.001);
        this.burst(dest, t, { type: 'highpass', freq: 3000, peak: vol, decay: 0.02 });
        if (Math.random() < 0.5) this.ricochet(dest, t + 0.03, vol);
        break;
      case 'blaetter':
        this.burst(dest, t, { type: 'highpass', freq: 1800, peak: vol * 0.8, attack: 0.005, decay: 0.35 });
        this.burst(dest, t, { type: 'bandpass', freq: 500, peak: vol * 0.3, decay: 0.06 });
        break;
      case 'koerper':
        this.burst(dest, t, { type: 'lowpass', freq: 500, peak: vol * 1.2, decay: 0.09, pink: true });
        this.tone(dest, t, 140, 60, vol, 0.08);
        break;
    }
  }

  private ricochet(dest: AudioNode, t: number, vol: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    o.type = 'sawtooth';
    const f0 = 2400 + Math.random() * 1500;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.35, t + 0.55);
    lfo.frequency.value = 28 + Math.random() * 20;
    lg.gain.value = 90;
    lfo.connect(lg).connect(o.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f0 * 0.8;
    bp.Q.value = 2;
    const g = ctx.createGain();
    this.env(g, t, vol * 0.18, 0.01, 0.55);
    o.connect(bp).connect(g).connect(dest);
    o.start(t); lfo.start(t);
    o.stop(t + 0.62); lfo.stop(t + 0.62);
  }

  /** Kugel knapp vorbei: Knall direkt am Ohr, kurz dumpfes Gehoer, Pfeifen. */
  whiz() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const side = Math.random() < 0.5 ? -0.8 : 0.8;
    const dest = this.bus(side, 0.3, 0, 1);
    this.burst(dest, t, { type: 'highpass', freq: 2500, peak: 1.5, decay: 0.008 });
    this.burst(dest, t + 0.003, { type: 'bandpass', freq: 4500, q: 1.5, sweepTo: 1200, peak: 0.6, decay: 0.18 });
    this.tinnitus(1.6, 0.03);
    this.muffleFor(1.2, 1800);
  }

  tinnitus(seconds: number, vol: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(this.out, t, 3900 + Math.random() * 400, 3800, vol, seconds, 'sine', 0.05);
  }

  muffleFor(seconds: number, freq: number) {
    if (!this.ctx) return;
    const f = this.muffleF.frequency, t = this.ctx.currentTime;
    f.cancelScheduledValues(t);
    f.setValueAtTime(freq, t);
    f.exponentialRampToValueAtTime(20000, t + seconds);
  }

  muffle(on: boolean) {
    if (!this.ctx) return;
    const f = this.muffleF.frequency, t = this.ctx.currentTime;
    f.cancelScheduledValues(t);
    f.setTargetAtTime(on ? 350 : 20000, t, on ? 0.15 : 0.3);
  }

  // ------------------------------------------------------------ Koerper

  breath(out: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.bus(0, 0.05);
    this.burst(dest, t, { type: 'bandpass', freq: out ? 650 : 1100, q: 0.9, peak: out ? 0.16 : 0.11, attack: out ? 0.12 : 0.2, decay: out ? 0.8 : 0.45, pink: true });
  }

  /** Schritt im Gras (Sprint zur Deckung). */
  step() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.bus((Math.random() - 0.5) * 0.3, 0.05);
    this.burst(dest, t, { type: 'lowpass', freq: 350, peak: 0.35, decay: 0.07, pink: true });
    this.burst(dest, t + 0.01, { type: 'highpass', freq: 2200, peak: 0.12, attack: 0.01, decay: 0.12 });
    // Ausruestung klappert
    if (Math.random() < 0.5) this.burst(dest, t + 0.03, { type: 'bandpass', freq: 2600, q: 8, peak: 0.05, decay: 0.03 });
  }

  /** Stoffrascheln beim Aufrichten/Abducken. */
  rustle() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(this.bus(0, 0.05), t, { type: 'bandpass', freq: 1400, q: 0.7, peak: 0.12, attack: 0.05, decay: 0.25 });
  }

  /** Pro Frame: Herzschlag, schweres Atmen, Voegel. */
  update() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.nextBeat < now) this.nextBeat = now + 0.05;
    while (this.nextBeat < now + 0.2) {
      const t = this.nextBeat;
      if (this.heartVolume > 0.02) {
        const v = this.heartVolume;
        for (const [off, amp] of [[0, 1], [0.15, 0.65]] as const) {
          this.tone(this.out, t + off, 62, 36, v * amp * 0.8, 0.14, 'sine', 0.008);
          this.burst(this.out, t + off, { type: 'lowpass', freq: 120, peak: v * amp * 0.5, attack: 0.008, decay: 0.1 });
        }
      }
      // Hecheln nach dem Sprint, im Takt der Atmung
      if (this.breathing > 0.05 && Math.random() < 0.5) {
        this.burst(this.out, t, { type: 'bandpass', freq: 900, q: 0.8, peak: this.breathing * 0.07, attack: 0.15, decay: 0.3, pink: true });
      }
      this.nextBeat += 60 / Math.max(40, this.heartRate);
    }
    if (this.birdsOn && now > this.nextBird) {
      this.bird(now + 0.05);
      this.nextBird = now + 2.5 + Math.random() * 7;
    }
  }
}

export const audio = new Audio();
