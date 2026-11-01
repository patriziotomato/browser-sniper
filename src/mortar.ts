import * as THREE from 'three';
import { Rng, clamp } from './core/rng';

/**
 * Moerserbeschuss: Wer zu lange von derselben Stelle schiesst, wird eingemessen.
 * "Verrat" steigt mit jedem eigenen Schuss und solange Gegner dich ungedeckt sehen.
 * Bei 100 % fordert der Gegner Feuer an: erst Gabelschuesse vor der Stellung, dann Wirkungsfeuer.
 */

export interface MortarImpact {
  t: number;
  pos: THREE.Vector3;
}

export interface FireMission {
  target: THREE.Vector3;
  firstImpact: number;
  lastImpact: number;
  impacts: MortarImpact[];
  bySpotter: boolean;
  cancelled: boolean;
}

export interface MortarSituation {
  time: number;
  exposed: boolean;
  /** Lebende Gegner, die deine Stellung kennen. */
  knowers: number;
  spotterKnows: boolean;
}

// Abstand zum Ziel und Zeit bis zum naechsten Einschlag: Gabel (weit, naeher, knapp), dann Wirkungsfeuer
const PATTERN: [dist: number, gap: number][] = [[34, 0], [19, 3.4], [9, 3.0], [3.5, 2.6], [2.5, 1.6], [4, 1.4]];

export class Mortar {
  heat = 0;
  mission: FireMission | null = null;
  /** Vorher kein Feuerauftrag (Rundenstart, Pause nach einem Beschuss). */
  private quietUntil = 20;

  constructor(private perShot: number, private countdown: number, private rng: Rng) {}

  get active(): boolean {
    return !!this.mission && !this.mission.cancelled;
  }

  onPlayerShot(knowers: number) {
    if (this.active) return;
    this.heat = clamp(this.heat + this.perShot * (1 + 0.12 * Math.min(knowers, 3)), 0, 1);
  }

  /** Nach einem Stellungswechsel verlieren die Gegner deine Spur weitgehend. */
  onRelocated() {
    this.heat *= 0.2;
  }

  /** Gibt true zurueck, wenn jetzt Feuer angefordert wird. */
  update(dt: number, s: MortarSituation): boolean {
    const m = this.mission;
    if (m) {
      if (m.cancelled || s.time > m.lastImpact + 2.5) {
        this.mission = null;
        this.heat = 0;
        this.quietUntil = s.time + 15;
      }
      return false;
    }
    let rate = 0;
    if (s.knowers === 0) rate = -0.012;
    else if (s.exposed) rate = 0.018 + 0.01 * Math.min(s.knowers, 3) + (s.spotterKnows ? 0.03 : 0);
    this.heat = clamp(this.heat + rate * dt, 0, 1);
    return this.heat >= 1 && s.time >= this.quietUntil;
  }

  /** Feuerauftrag auf `target`. `towardEnemy` zeigt vom Ziel zu den Gegnern (dort landen die ersten Granaten). */
  call(target: THREE.Vector3, towardEnemy: THREE.Vector3, time: number, bySpotter: boolean): FireMission {
    const fwd = towardEnemy.clone().setY(0).normalize();
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    let t = time + this.countdown - (bySpotter ? 2 : 0);
    const impacts: MortarImpact[] = PATTERN.map(([d, gap], i) => {
      t += gap;
      // Gabel: vor der Stellung, leicht seitlich; Wirkungsfeuer: rundherum
      const a = i < 3 ? this.rng.range(-0.55, 0.55) : this.rng.range(0, Math.PI * 2);
      const r = d * this.rng.range(0.8, 1.15);
      const pos = target.clone().addScaledVector(fwd, Math.cos(a) * r).addScaledVector(side, Math.sin(a) * r);
      return { t, pos };
    });
    this.mission = { target: target.clone(), firstImpact: impacts[0].t, lastImpact: t, impacts, bySpotter, cancelled: false };
    this.heat = 1;
    return this.mission;
  }

  /** Spotter vor dem ersten Einschlag ausgeschaltet: Feuerauftrag platzt. */
  cancel(time: number): boolean {
    const m = this.mission;
    if (!m || m.cancelled || !m.bySpotter || time >= m.firstImpact) return false;
    m.cancelled = true;
    return true;
  }
}
