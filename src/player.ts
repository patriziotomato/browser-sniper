import * as THREE from 'three';
import { RIFLE, settings } from './config';
import { clamp, damp, lerp, smoothstep } from './core/rng';
import { CoverDef } from './world/cover';
import { Terrain } from './world/terrain';
import { audio } from './audio';
import { zeroAngle } from './ballistics';

export type PlayerState = 'intro' | 'moving' | 'ducked' | 'rising' | 'up' | 'lowering' | 'dead' | 'won';

const MIL = 0.001;

export class Player {
  state: PlayerState = 'intro';
  stateT = 0;
  yaw = 0;
  pitch = 0;
  baseYaw = 0;
  scoped = false;
  scopeBlend = 0; // 0..1 Uebergang
  zoom = 6;
  zero = 300;
  ammo = RIFLE.magazine;
  boltT = 0;
  reloadT = 0;
  pulse = 150;
  breathPhase = 0;
  holdingBreath = false;
  holdT = 0;
  breathDebt = 0; // nach zu langem Luftanhalten
  exposedFor = 0;
  shots = 0;
  private recoil = 0;
  private sway = new THREE.Vector2();
  private tremorSeed = Math.random() * 100;
  readonly aimEye = new THREE.Vector3();
  readonly duckEye = new THREE.Vector3();
  readonly eye = new THREE.Vector3();
  private runPath: THREE.CatmullRomCurve3;
  private runDur = 3.6;
  /** Kamerawackeln (Explosionen), klingt von selbst ab. */
  shake = 0;
  private deathRoll = 0;
  private lastStep = -1;
  rightHeld = false;
  zeroKeyHeld = false;

  constructor(private camera: THREE.PerspectiveCamera, private terrain: Terrain, public cover: CoverDef, enemyCenter: THREE.Vector3, rngLateral: number) {
    cover.group.updateMatrixWorld(true);
    this.aimEye.copy(cover.aimEye).applyMatrix4(cover.group.matrixWorld);
    this.duckEye.copy(cover.duckEye).applyMatrix4(cover.group.matrixWorld);
    this.baseYaw = Math.atan2(-(enemyCenter.x - this.aimEye.x), -(enemyCenter.z - this.aimEye.z));
    this.yaw = this.baseYaw;
    this.pitch = Math.atan2(enemyCenter.y - this.aimEye.y, Math.hypot(enemyCenter.x - this.aimEye.x, enemyCenter.z - this.aimEye.z));

    // Sprintweg: von hinten-seitlich zur Deckung
    const back = new THREE.Vector3(Math.sin(this.baseYaw), 0, Math.cos(this.baseYaw));
    const side = new THREE.Vector3(back.z, 0, -back.x);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const p = this.duckEye.clone().addScaledVector(back, 24 * (1 - t) + 0.0).addScaledVector(side, rngLateral * 12 * (1 - t) * (1 - t));
      const g = terrain.heightAt(p.x, p.z);
      p.y = g + lerp(1.65, this.duckEye.y - terrain.heightAt(this.duckEye.x, this.duckEye.z), smoothstep(0.75, 1, t));
      if (i === 6) p.copy(this.duckEye);
      pts.push(p);
    }
    this.runPath = new THREE.CatmullRomCurve3(pts);
    this.eye.copy(pts[0]);
  }

  /** Geduckter Sprint hinter dem Grat zu einer anderen Deckung. */
  relocate(cover: CoverDef, enemyCenter: THREE.Vector3) {
    const from = this.eye.clone();
    this.cover = cover;
    cover.group.updateMatrixWorld(true);
    this.aimEye.copy(cover.aimEye).applyMatrix4(cover.group.matrixWorld);
    this.duckEye.copy(cover.duckEye).applyMatrix4(cover.group.matrixWorld);
    this.baseYaw = Math.atan2(-(enemyCenter.x - this.aimEye.x), -(enemyCenter.z - this.aimEye.z));
    this.yaw = this.baseYaw;
    this.pitch = Math.atan2(enemyCenter.y - this.aimEye.y, Math.hypot(enemyCenter.x - this.aimEye.x, enemyCenter.z - this.aimEye.z));
    // Weg leicht hinter der Kante (vom Gegner weg), damit der Grat dich teilweise verdeckt
    const back = new THREE.Vector3(Math.sin(this.baseYaw), 0, Math.cos(this.baseYaw));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const p = from.clone().lerp(this.duckEye, t).addScaledVector(back, Math.sin(t * Math.PI) * 4.5);
      p.y = this.terrain.heightAt(p.x, p.z) + 1.2;
      if (i === 0) p.copy(from);
      if (i === 8) p.copy(this.duckEye);
      pts.push(p);
    }
    this.runPath = new THREE.CatmullRomCurve3(pts);
    this.runDur = 0.8 + this.runPath.getLength() / 7.5;
    this.holdingBreath = false;
    this.rightHeld = false;
    this.setState('moving');
    audio.rustle();
  }

  get moving(): boolean {
    return this.state === 'moving';
  }

  get exposed(): boolean {
    if (this.state === 'moving') return this.stateT > 0.5 && this.stateT < this.runDur - 0.5;
    return this.state === 'up' || (this.state === 'rising' && this.stateT > 0.25) || (this.state === 'lowering' && this.stateT < 0.12);
  }

  get canFire(): boolean {
    return (this.state === 'up') && this.boltT <= 0 && this.reloadT <= 0 && this.ammo > 0;
  }

  get fov(): number {
    return lerp(RIFLE.baseFov, RIFLE.baseFov / this.zoom, this.scopeBlend);
  }

  look(dx: number, dy: number) {
    if (this.state === 'intro' || this.state === 'moving' || this.state === 'dead' || this.state === 'won') return;
    const sens = 0.0022 * settings.sensitivity * (this.fov / RIFLE.baseFov);
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    const yd = this.yaw - this.baseYaw;
    this.yaw = this.baseYaw + clamp(yd, -1.3, 1.3);
    this.pitch = clamp(this.pitch, -0.55, 0.35);
  }

  wheel(delta: number) {
    if (this.zeroKeyHeld) {
      this.zero = clamp(this.zero + (delta < 0 ? RIFLE.zeroStep : -RIFLE.zeroStep), RIFLE.zeroMin, RIFLE.zeroMax);
      audio.zoomTick();
    } else {
      const z = clamp(this.zoom * (delta < 0 ? 1.15 : 1 / 1.15), RIFLE.zoomMin, RIFLE.zoomMax);
      if (z !== this.zoom) audio.zoomTick();
      this.zoom = z;
    }
  }

  raise() {
    if (this.state === 'ducked' || this.state === 'lowering') {
      this.setState('rising');
      audio.rustle();
    }
  }

  duck() {
    if (this.state === 'up' || this.state === 'rising') {
      this.setState('lowering');
      this.holdingBreath = false;
      audio.rustle();
    }
  }

  setBreath(hold: boolean) {
    if (hold && !this.holdingBreath && this.breathDebt <= 0 && this.scoped) {
      this.holdingBreath = true;
      this.holdT = 0;
      audio.breath(false);
    } else if (!hold && this.holdingBreath) {
      this.releaseBreath();
    }
  }

  private releaseBreath() {
    this.holdingBreath = false;
    if (this.holdT > 4) this.breathDebt = Math.min(5, (this.holdT - 3) * 1.4);
    audio.breath(true);
  }

  setState(s: PlayerState) {
    this.state = s;
    this.stateT = 0;
  }

  nearMiss() {
    this.pulse = Math.min(175, this.pulse + 22);
  }

  /** Richtung und Startpunkt der Kugel (inkl. Atmung, Zeroing). */
  shotRay(): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const ang = zeroAngle(this.zero);
    dir.applyAxisAngle(right, ang);
    const origin = this.camera.position.clone().addScaledVector(up, -RIFLE.sightHeight).addScaledVector(dir, 0.6);
    return { origin, dir };
  }

  onFired() {
    this.ammo--;
    this.shots++;
    this.boltT = RIFLE.boltTime;
    this.recoil = 1;
    if (this.holdingBreath) this.releaseBreath();
    audio.bolt(0.55, 0.35);
  }

  /** Neigung der Visierlinie in Grad (fuer HUD). */
  get inclineDeg(): number {
    return THREE.MathUtils.radToDeg(this.pitch);
  }

  update(dt: number, danger: number) {
    this.stateT += dt;
    // Puls: sinkt langsam, steigt bei Gefahr
    const restPulse = 64 + danger * 55;
    this.pulse = damp(this.pulse, restPulse, this.state === 'ducked' ? 0.09 : 0.055, dt);
    audio.heartRate = this.pulse;
    audio.breathing = this.state === 'intro' || this.state === 'moving' ? 0.6 : clamp((this.pulse - 100) / 60, 0, 1) * (this.holdingBreath ? 0 : 1);
    audio.heartVolume = clamp((this.pulse - 85) / 70, 0, 0.9) * 0.6 + danger * 0.5;

    if (this.boltT > 0) this.boltT -= dt;
    if (this.state === 'ducked' && this.ammo < RIFLE.magazine && this.reloadT <= 0 && this.stateT > 0.3) {
      this.reloadT = RIFLE.reloadTime;
      audio.reload();
    }
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.ammo = RIFLE.magazine;
    }

    // Atmung
    if (this.holdingBreath) {
      this.holdT += dt;
      if (this.holdT > 6.5) this.releaseBreath();
    }
    if (this.breathDebt > 0) this.breathDebt -= dt;
    const breathRate = 0.2 + (this.pulse - 60) / 400 + (this.breathDebt > 0 ? 0.25 : 0);
    if (!this.holdingBreath) this.breathPhase += dt * Math.PI * 2 * breathRate;

    let target: THREE.Vector3;
    switch (this.state) {
      case 'intro':
      case 'moving': {
        const t = clamp(this.stateT / this.runDur, 0, 1);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.runPath.getPointAt(e, this.eye);
        const bob = Math.sin(this.stateT * 15) * 0.07 * (1 - smoothstep(0.75, 1, t));
        const stepPhase = Math.floor((this.stateT * 15) / Math.PI);
        if (stepPhase !== this.lastStep && t < 0.92) {
          this.lastStep = stepPhase;
          audio.step();
        }
        this.eye.y += bob;
        if (t >= 1) {
          this.pulse = this.state === 'intro' ? 150 : Math.max(this.pulse, 140);
          this.setState('ducked');
        }
        target = this.eye;
        break;
      }
      case 'rising':
        if (this.stateT > 0.45) this.setState('up');
        target = this.duckEye.clone().lerp(this.aimEye, smoothstep(0, 0.45, this.stateT));
        break;
      case 'lowering':
        if (this.stateT > 0.3) this.setState('ducked');
        target = this.aimEye.clone().lerp(this.duckEye, smoothstep(0, 0.3, this.stateT));
        break;
      case 'up':
        target = this.aimEye;
        break;
      case 'dead':
        target = this.eye.clone().setY(lerp(this.eye.y, this.duckEye.y - 0.4, Math.min(1, dt * 2)));
        this.deathRoll = Math.min(1.2, this.deathRoll + dt * 1.5);
        break;
      default:
        target = this.duckEye;
    }
    if (this.state !== 'intro' && this.state !== 'moving') this.eye.lerp(target, 1 - Math.exp(-14 * dt));

    // Zielfernrohr
    this.scoped = this.state === 'up' && this.rightHeld;
    this.scopeBlend = damp(this.scopeBlend, this.scoped ? 1 : 0, 16, dt);
    if (!this.scoped && this.holdingBreath) this.releaseBreath();

    if (this.state === 'up' || this.state === 'rising') this.exposedFor += dt;
    else this.exposedFor = Math.max(0, this.exposedFor - dt * 2);

    // Schwanken in Milliradiant
    const hold = this.holdingBreath ? 0.15 : 1;
    const debt = this.breathDebt > 0 ? 2.2 : 1;
    const breathAmp = 1.5 * hold * debt;
    const ph = this.breathPhase;
    let sx = Math.sin(ph) * breathAmp * 0.7;
    let sy = Math.sin(ph * 2) * breathAmp * 0.35 + Math.sin(ph) * breathAmp * 0.6;
    const beatPhase = (performance.now() / 1000) * (this.pulse / 60);
    const beat = Math.pow(Math.max(0, Math.sin(beatPhase * Math.PI * 2)), 12);
    const pulseAmp = clamp((this.pulse - 62) / 80, 0, 1.3) * 0.9;
    sy += beat * pulseAmp;
    const tt = performance.now() / 1000 + this.tremorSeed;
    sx += (Math.sin(tt * 3.1) * 0.5 + Math.sin(tt * 7.3) * 0.3) * 0.22 * (0.6 + hold * 0.4);
    sy += (Math.sin(tt * 2.7) * 0.5 + Math.sin(tt * 6.1) * 0.3) * 0.22 * (0.6 + hold * 0.4);
    this.sway.set(sx * MIL * this.scopeBlend + sx * MIL * 0.3, sy * MIL * this.scopeBlend + sy * MIL * 0.3);
    this.recoil = Math.max(0, this.recoil - dt * 3.5);

    // Kamera setzen
    this.camera.position.copy(this.eye);
    const yaw = this.yaw + this.sway.x;
    const pitch = this.pitch + this.sway.y + this.recoil * this.recoil * 0.035;
    let lookYaw = yaw, lookPitch = pitch;
    if (this.state === 'intro' || this.state === 'moving') {
      const t = clamp(this.stateT / this.runDur, 0, 1);
      const dir = new THREE.Vector3();
      this.runPath.getTangentAt(Math.min(0.99, t), dir);
      const runYaw = Math.atan2(-dir.x, -dir.z);
      lookYaw = lerp(runYaw, this.baseYaw, smoothstep(0.55, 1, t));
      lookPitch = lerp(-0.12, this.pitch, smoothstep(0.6, 1, t));
    }
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = lookYaw;
    this.camera.rotation.x = lookPitch;
    this.camera.rotation.z = this.state === 'dead' ? this.deathRoll * 0.8 : 0;
    if (this.shake > 0.001) {
      const k = this.shake * this.shake;
      const n = performance.now() / 1000;
      this.camera.rotation.x += (Math.sin(n * 47) + Math.sin(n * 83) * 0.5) * 0.02 * k;
      this.camera.rotation.y += (Math.sin(n * 53 + 1) + Math.sin(n * 71) * 0.5) * 0.02 * k;
      this.camera.rotation.z += Math.sin(n * 39 + 2) * 0.03 * k;
      this.camera.position.y += Math.sin(n * 61) * 0.05 * k;
      this.shake = Math.max(0, this.shake - dt * 1.6);
    }
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  get breathStatus(): number {
    if (this.breathDebt > 0) return -this.breathDebt / 5;
    return this.holdingBreath ? 1 - this.holdT / 6.5 : 1;
  }
}
