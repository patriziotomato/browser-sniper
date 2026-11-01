import * as THREE from 'three';
import { Humanoid, PoseName } from './humanoid';
import { Rng, clamp } from '../core/rng';

export type EnemyType = 'wache' | 'patrouille' | 'scharfschuetze' | 'spotter';
export type Intent = 'beobachten' | 'zielen' | 'stellung_wechseln' | 'alarmieren' | 'deckung';
/** Feste Reihenfolge (Jev reagiert auf die Reihenfolge der Optionen). */
export const INTENTS: Intent[] = ['beobachten', 'zielen', 'stellung_wechseln', 'alarmieren', 'deckung'];
export const INTENT_LABEL: Record<Intent, string> = {
  beobachten: 'beobachten',
  zielen: 'anlegen und zielen',
  stellung_wechseln: 'Position wechseln',
  alarmieren: 'Kameraden alarmieren',
  deckung: 'in Deckung bleiben',
};

export const TYPE_INFO: Record<EnemyType, { label: string; persona: string; detect: number; accuracy: number; cone: number; shoots: boolean }> = {
  wache: { label: 'Wachposten', persona: 'gelangweilter Wachposten, reagiert langsam', detect: 0.11, accuracy: 0.55, cone: 1.2, shoots: true },
  patrouille: { label: 'Patrouille', persona: 'aufmerksamer Soldat auf Streife', detect: 0.1, accuracy: 0.6, cone: 1.1, shoots: true },
  scharfschuetze: { label: 'Scharfschuetze', persona: 'vorsichtiger, erfahrener Scharfschuetze', detect: 0.2, accuracy: 1.0, cone: 0.8, shoots: true },
  spotter: { label: 'Spotter', persona: 'Beobachter mit Fernglas, unbewaffnet im Einsatz', detect: 0.34, accuracy: 0, cone: 0.45, shoots: false },
};

export type AimPhase = 'none' | 'raise' | 'glint' | 'window' | 'hold' | 'bolt';

export interface PlayerView {
  eye: THREE.Vector3; // Augenposition beim Zielen (Welt)
  exposed: boolean;
  camo: number;
  penetrable: boolean;
}

export interface EnemyEnv {
  dt: number;
  time: number;
  player: PlayerView;
  difficulty: { reactionWindow: number; aimTime: number; detection: number; enemyAccuracy: number };
  lineOfSight: (a: THREE.Vector3, b: THREE.Vector3) => boolean;
  groundAt: (x: number, z: number) => number;
  sunDir: THREE.Vector3;
  overcast: boolean;
  onAimStart: (e: Enemy) => void;
  onFire: (e: Enemy) => void;
  onAlarm: (e: Enemy) => void;
}

export type HitZone = 'kopf' | 'torso' | 'bein';

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

export class Enemy {
  readonly human = new Humanoid();
  readonly pos: THREE.Vector3;
  readonly home: THREE.Vector3;
  yaw = 0;
  dead = false;
  tagged = false;
  wounds = 0;
  awareness = 0;
  knowsPlayer = false;
  alarmed = false;
  nerves = 0.2;
  intent: Intent = 'beobachten';
  intentSource: 'jev' | 'lokal' = 'lokal';
  probs: Record<Intent, number> = { beobachten: 1, zielen: 0, stellung_wechseln: 0, alarmieren: 0, deckung: 0 };
  detectP = 0;
  phase: AimPhase = 'none';
  phaseT = 0;
  glint = 0;
  shotsFired = 0;
  missedShots = 0;
  lastNearMiss = -99;
  lastHeardShot = -99;
  suspicionShot = false;
  canSeePlayer = false;
  private losTimer = 0;
  private moveTarget: THREE.Vector3 | null = null;
  private waypoints: THREE.Vector3[] = [];
  private wp = 0;
  private scanBase = 0;
  private scanT: number;
  private coverT = 0;
  private holdLimit = 4;
  readonly glintSprite: THREE.Sprite;
  readonly zones = { head: new THREE.Vector3(), torsoA: new THREE.Vector3(), torsoB: new THREE.Vector3(), legA: new THREE.Vector3(), legB: new THREE.Vector3() };

  constructor(readonly id: number, readonly type: EnemyType, pos: THREE.Vector3, playerPos: THREE.Vector3, glowTex: THREE.Texture, private rng: Rng) {
    this.pos = pos.clone();
    this.home = pos.clone();
    this.human.root.position.copy(pos);
    this.human.root.scale.setScalar(1.1);
    this.scanBase = Math.atan2(playerPos.x - pos.x, playerPos.z - pos.z);
    this.yaw = this.scanBase + rng.range(-0.8, 0.8);
    this.scanT = rng.range(0, 100);
    this.glintSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0xfff6e0, transparent: true, opacity: 0, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false }),
    );
    this.glintSprite.scale.setScalar(0.035);
    this.glintSprite.renderOrder = 10;
    this.human.setPose(type === 'scharfschuetze' ? 'prone' : type === 'spotter' ? 'binoculars' : type === 'patrouille' ? 'lowReady' : 'stand');
  }

  get info() {
    return TYPE_INFO[this.type];
  }

  setWaypoints(pts: THREE.Vector3[]) {
    this.waypoints = pts;
  }

  /** Gegner weiss, dass ein Schuss gefallen ist. */
  hearShot(distance: number, coverCamo: number, time: number) {
    if (this.dead) return;
    this.lastHeardShot = time;
    const closeness = clamp(1 - distance / 1100, 0.1, 1);
    this.awareness = Math.min(1.2, this.awareness + (0.25 + 0.45 * closeness) * coverCamo);
    this.nerves = Math.min(1, this.nerves + 0.15);
    if (this.awareness >= 1) this.knowsPlayer = true;
  }

  comradeDown(time: number) {
    this.nerves = Math.min(1, this.nerves + 0.25);
    this.lastHeardShot = time;
  }

  alarm() {
    if (this.dead) return;
    this.awareness = Math.max(this.awareness, 0.9);
    this.nerves = Math.min(1, this.nerves + 0.1);
  }

  setIntent(intent: Intent, source: 'jev' | 'lokal') {
    if (this.dead) return;
    // Laufenden Schuss nicht durch Beobachten abbrechen
    if (this.phase === 'window' && intent !== 'deckung') return;
    if (intent === this.intent) {
      this.intentSource = source;
      return;
    }
    this.intent = intent;
    this.intentSource = source;
    if (intent !== 'zielen' && this.phase !== 'bolt') this.phase = 'none';
    if (intent === 'stellung_wechseln') this.pickNewPosition();
    if (intent === 'deckung') this.coverT = this.rng.range(2.5, 5);
  }

  private pickNewPosition() {
    const side = this.rng.chance(0.5) ? 1 : -1;
    const dist = this.rng.range(25, 60);
    const toPlayer = this.scanBase;
    const lateral = toPlayer + (Math.PI / 2) * side;
    this.moveTarget = new THREE.Vector3(this.pos.x + Math.sin(lateral) * dist, 0, this.pos.z + Math.cos(lateral) * dist + this.rng.range(-10, 10));
  }

  update(env: EnemyEnv) {
    const dt = env.dt;
    this.human.update(dt);
    this.updateGlint(env);
    if (this.dead) return;

    // Sichtlinie nur alle 0.4 s pruefen (teuer)
    this.losTimer -= dt;
    const eye = tmpA.copy(this.pos).setY(this.pos.y + (this.human.pose === 'prone' || this.human.pose === 'proneAim' ? 0.4 : 1.6));
    if (this.losTimer <= 0) {
      this.losTimer = 0.4;
      this.canSeePlayer = env.lineOfSight(eye, env.player.eye);
    }
    const toP = tmpB.copy(env.player.eye).sub(this.pos);
    const dist = Math.hypot(toP.x, toP.z);
    const yawToPlayer = Math.atan2(toP.x, toP.z);

    // Wahrnehmung
    const yawDiff = Math.abs(angleDiff(this.yaw, yawToPlayer));
    const inCone = yawDiff < this.info.cone;
    if (env.player.exposed && this.canSeePlayer && inCone && this.intent !== 'stellung_wechseln') {
      const distF = clamp(320 / dist, 0.3, 1.6);
      const alertF = this.awareness > 0.4 ? 1.6 : 1;
      this.awareness = Math.min(1.2, this.awareness + this.info.detect * env.difficulty.detection * env.player.camo * distF * alertF * dt);
    } else {
      this.awareness = Math.max(this.knowsPlayer ? 0.6 : 0, this.awareness - 0.03 * dt);
    }
    if (this.awareness >= 1) this.knowsPlayer = true;

    switch (this.intent) {
      case 'beobachten': this.doObserve(env, dt); break;
      case 'zielen': this.doAim(env, dt, yawToPlayer, dist); break;
      case 'stellung_wechseln': this.doMove(env, dt); break;
      case 'alarmieren': this.doAlarm(env, dt, yawToPlayer); break;
      case 'deckung': this.doCover(env, dt); break;
    }

    this.human.root.position.copy(this.pos);
    this.human.root.rotation.y = this.yaw;
  }

  private turnTo(target: number, rate: number, dt: number) {
    const d = angleDiff(this.yaw, target);
    this.yaw += clamp(d, -rate * dt, rate * dt);
  }

  private doObserve(env: EnemyEnv, dt: number) {
    this.human.walkAmount = 0;
    this.phase = this.phase === 'bolt' ? 'bolt' : 'none';
    if (this.phase === 'bolt') this.tickBolt(dt);
    this.scanT += dt;
    if (this.type === 'patrouille' && this.waypoints.length > 1 && !this.knowsPlayer) {
      const tgt = this.waypoints[this.wp];
      if (this.walkTo(tgt, 1.4, env, dt)) this.wp = (this.wp + 1) % this.waypoints.length;
      this.human.setPose('lowReady');
      return;
    }
    const sweep = this.type === 'spotter' ? 0.9 : this.type === 'scharfschuetze' ? 0.6 : 1.1;
    const speed = this.type === 'wache' ? 0.18 : 0.3;
    const look = this.scanBase + Math.sin(this.scanT * speed) * sweep * (this.knowsPlayer ? 0.3 : 1);
    this.turnTo(look, 0.8, dt);
    this.human.setPose(this.type === 'scharfschuetze' ? 'prone' : this.type === 'spotter' ? 'binoculars' : this.knowsPlayer ? 'lowReady' : this.type === 'wache' ? 'stand' : 'lowReady');
  }

  private walkTo(tgt: THREE.Vector3, speed: number, env: EnemyEnv, dt: number): boolean {
    const dx = tgt.x - this.pos.x, dz = tgt.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) {
      this.human.walkAmount = Math.max(0, this.human.walkAmount - dt * 4);
      return true;
    }
    const sp = speed * (this.wounds > 0 ? 0.55 : 1);
    this.pos.x += (dx / d) * sp * dt;
    this.pos.z += (dz / d) * sp * dt;
    this.pos.y = env.groundAt(this.pos.x, this.pos.z);
    this.turnTo(Math.atan2(dx, dz), 3, dt);
    this.human.walkAmount = Math.min(1, this.human.walkAmount + dt * 4);
    this.human.walkPhase += dt * sp * 3.4;
    return false;
  }

  private doMove(env: EnemyEnv, dt: number) {
    this.phase = 'none';
    if (!this.moveTarget) this.pickNewPosition();
    this.human.setPose('lowReady');
    if (this.walkTo(this.moveTarget!, 3.6, env, dt)) {
      this.moveTarget = null;
      this.intent = 'beobachten';
    }
  }

  private doAlarm(env: EnemyEnv, dt: number, yawToPlayer: number) {
    this.human.walkAmount = 0;
    this.turnTo(yawToPlayer, 1.5, dt);
    if (!this.alarmed && (this.knowsPlayer || this.awareness > 0.6)) {
      this.alarmed = true;
      env.onAlarm(this);
    }
    this.phaseT += dt;
    if (this.phaseT > 1.5) {
      this.phaseT = 0;
      this.intent = 'beobachten';
    }
  }

  private doCover(_env: EnemyEnv, dt: number) {
    this.human.walkAmount = 0;
    this.phase = this.phase === 'bolt' ? 'bolt' : 'none';
    if (this.phase === 'bolt') this.tickBolt(dt);
    this.human.setPose(this.type === 'scharfschuetze' || this.type === 'spotter' ? 'prone' : 'crouch');
    this.coverT -= dt;
    if (this.coverT <= 0) this.intent = 'beobachten';
  }

  private tickBolt(dt: number) {
    this.phaseT += dt;
    if (this.phaseT > 1.5) {
      this.phase = 'none';
      this.phaseT = 0;
    }
  }

  private doAim(env: EnemyEnv, dt: number, yawToPlayer: number, dist: number) {
    this.human.walkAmount = 0;
    if (!this.info.shoots) {
      this.intent = 'beobachten';
      return;
    }
    // Ohne Wissen ueber den Spieler nur auf Verdacht (Busch) schiessen
    const mayShoot = this.knowsPlayer || (this.suspicionShot && env.player.penetrable && this.awareness > 0.5);
    if (!mayShoot) {
      this.intent = 'beobachten';
      return;
    }
    this.turnTo(yawToPlayer, 2.2, dt);
    const prone = this.type === 'scharfschuetze';
    this.human.setPose(prone ? 'proneAim' : 'aim');
    const D = env.difficulty;
    const nervF = 1 - this.nerves * 0.25;
    this.phaseT += dt;
    switch (this.phase) {
      case 'none':
        this.phase = 'raise';
        this.phaseT = 0;
        env.onAimStart(this);
        break;
      case 'bolt':
        this.glint = Math.max(0, this.glint - dt * 2);
        if (this.phaseT > 1.5) { this.phase = 'glint'; this.phaseT = 0; }
        break;
      case 'raise':
        if (this.phaseT > 0.8) { this.phase = 'glint'; this.phaseT = 0; }
        break;
      case 'glint': {
        const t = D.aimTime * nervF * (this.type === 'scharfschuetze' ? 1 : 1.25);
        this.glint = clamp(this.phaseT / t, 0, 1);
        if (this.phaseT >= t) {
          if (env.player.exposed || (this.suspicionShot && env.player.penetrable)) { this.phase = 'window'; this.phaseT = 0; }
          else { this.phase = 'hold'; this.phaseT = 0; this.holdLimit = this.rng.range(3, 6.5); }
        }
        break;
      }
      case 'hold':
        // Vorgehalten auf die Stelle, an der du abgetaucht bist
        this.glint = 0.75 + 0.1 * Math.sin(env.time * 9);
        if (env.player.exposed) { this.phase = 'window'; this.phaseT = 0; }
        else if (this.phaseT > this.holdLimit) { this.phase = 'none'; this.glint = 0; this.intent = 'beobachten'; }
        break;
      case 'window':
        this.glint = 1;
        if (this.phaseT >= D.reactionWindow * (dist < 250 ? 0.85 : 1)) {
          env.onFire(this);
          this.shotsFired++;
          this.phase = 'bolt';
          this.phaseT = 0;
          this.glint = 0.3;
        }
        break;
    }
  }

  private updateGlint(env: EnemyEnv) {
    const s = this.glintSprite;
    if (this.dead || this.glint < 0.02 || !this.info.shoots && this.type !== 'spotter') {
      s.material.opacity = 0;
      s.visible = false;
      if (this.type !== 'spotter' || this.dead) return;
    }
    let level = this.glint;
    let front: THREE.Object3D = this.human.scopeFront;
    if (this.type === 'spotter') {
      // Fernglas blitzt schwach, wenn er in deine Richtung schaut
      const toP = tmpB.copy(env.player.eye).sub(this.pos);
      const yawDiff = Math.abs(angleDiff(this.yaw, Math.atan2(toP.x, toP.z)));
      level = this.dead ? 0 : clamp(1 - yawDiff / 0.35, 0, 1) * 0.45;
      front = this.human.binoFront;
    }
    if (level < 0.02) {
      s.visible = false;
      return;
    }
    front.getWorldPosition(s.position);
    const toP = tmpB.copy(env.player.eye).sub(s.position).normalize();
    const sunF = clamp(env.sunDir.dot(toP) * 0.5 + 0.5, 0, 1);
    const flicker = 0.85 + 0.15 * Math.sin(env.time * 23 + this.id * 3);
    s.visible = true;
    s.material.opacity = clamp(level * (0.45 + 0.75 * sunF) * (env.overcast ? 0.6 : 1) * flicker, 0, 1);
    s.scale.setScalar(0.012 + 0.03 * level);
  }

  /** Strecke a->b gegen Trefferzonen pruefen. */
  hitTest(a: THREE.Vector3, b: THREE.Vector3): { zone: HitZone; point: THREE.Vector3 } | null {
    if (this.dead) return null;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    if (mid.distanceToSquared(this.pos) > 4 * 4 + a.distanceToSquared(b)) return null;
    this.human.root.updateMatrixWorld(true);
    const z = this.human.hitzones(this.zones);
    const hHead = segSegDist(a, b, z.head, z.head);
    if (hHead.d < 0.145) return { zone: 'kopf', point: hHead.p };
    const hTorso = segSegDist(a, b, z.torsoA, z.torsoB);
    if (hTorso.d < 0.22) return { zone: 'torso', point: hTorso.p };
    const hLeg = segSegDist(a, b, z.legA, z.legB);
    if (hLeg.d < 0.155) return { zone: 'bein', point: hLeg.p };
    return null;
  }

  /** Gibt true zurueck, wenn der Gegner stirbt. */
  takeHit(zone: HitZone, bulletDir: THREE.Vector3, time: number): boolean {
    this.awareness = 1.2;
    this.knowsPlayer = true;
    this.lastNearMiss = time;
    if (zone === 'bein') {
      this.wounds++;
      if (this.wounds < 2) {
        this.nerves = 1;
        this.setIntent('deckung', this.intentSource);
        return false;
      }
    }
    this.dead = true;
    this.phase = 'none';
    this.glint = 0;
    this.human.die(bulletDir);
    return true;
  }

  nearMiss(time: number) {
    this.lastNearMiss = time;
    this.missedShots++;
    this.awareness = Math.min(1.2, this.awareness + 0.5);
    this.nerves = Math.min(1, this.nerves + 0.3);
  }
}

export function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Abstand zwischen zwei Strecken, plus Punkt auf der ersten Strecke. */
function segSegDist(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): { d: number; p: THREE.Vector3 } {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) return { d: p1.distanceTo(p2), p: p1.clone() };
  if (a <= 1e-9) { t = clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-9) { s = clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = p1.clone().addScaledVector(d1, s), c2 = p2.clone().addScaledVector(d2, t);
  return { d: c1.distanceTo(c2), p: c1 };
}

export type { PoseName };
