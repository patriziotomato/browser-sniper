import * as THREE from 'three';
import { RIFLE } from './config';

const G = 9.81;
const SUB_DT = 0.001; // 1 ms Integrationsschritt

/** Beschleunigung durch Schwerkraft + quadratischen Luftwiderstand relativ zur Luft (Wind). */
function accel(v: THREE.Vector3, wind: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(v).sub(wind);
  const speed = out.length();
  out.multiplyScalar(-RIFLE.dragK * speed);
  out.y -= G;
  return out;
}

export interface SegmentHit<T> {
  point: THREE.Vector3;
  data: T;
}

export class Bullet<T = unknown> {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  time = 0;
  traveled = 0;
  alive = true;
  readonly origin: THREE.Vector3;
  readonly trail: THREE.Vector3[] = [];
  private a = new THREE.Vector3();
  private prev = new THREE.Vector3();

  constructor(origin: THREE.Vector3, dir: THREE.Vector3, speed = RIFLE.muzzleVelocity) {
    this.origin = origin.clone();
    this.pos = origin.clone();
    this.vel = dir.clone().normalize().multiplyScalar(speed);
    this.trail.push(this.pos.clone());
  }

  /** Simuliert dt Sekunden. collide(a, b) liefert einen Treffer auf der Strecke a->b oder null. */
  advance(dt: number, wind: THREE.Vector3, collide: (a: THREE.Vector3, b: THREE.Vector3) => SegmentHit<T> | null): SegmentHit<T> | null {
    let remaining = dt;
    while (remaining > 1e-9 && this.alive) {
      const h = Math.min(SUB_DT, remaining);
      remaining -= h;
      this.prev.copy(this.pos);
      // Semi-implizites Euler reicht bei 1 ms voellig
      accel(this.vel, wind, this.a);
      this.vel.addScaledVector(this.a, h);
      this.pos.addScaledVector(this.vel, h);
      this.time += h;
      this.traveled += this.prev.distanceTo(this.pos);
      const hit = collide(this.prev, this.pos);
      if (hit) {
        this.alive = false;
        this.pos.copy(hit.point);
        this.trail.push(hit.point.clone());
        return hit;
      }
      if (this.time > 4 || this.pos.y < -200) {
        this.alive = false;
        return null;
      }
    }
    if (this.trail.length === 0 || this.trail[this.trail.length - 1].distanceToSquared(this.pos) > 25) this.trail.push(this.pos.clone());
    return null;
  }
}

/**
 * Winkel (rad) zwischen Visierlinie und Laufachse, damit die Kugel auf zeroDist die Visierlinie schneidet.
 * Flaches Schiessen, ohne Wind.
 */
const zeroCache = new Map<number, number>();
export function zeroAngle(zeroDist: number): number {
  const cached = zeroCache.get(zeroDist);
  if (cached !== undefined) return cached;
  const heightAt = (angle: number) => {
    const v = new THREE.Vector3(Math.cos(angle) * RIFLE.muzzleVelocity, Math.sin(angle) * RIFLE.muzzleVelocity, 0);
    const p = new THREE.Vector3(0, -RIFLE.sightHeight, 0);
    const a = new THREE.Vector3();
    const zero = new THREE.Vector3();
    let guard = 0;
    while (p.x < zeroDist && guard++ < 10000) {
      accel(v, zero, a);
      v.addScaledVector(a, SUB_DT);
      p.addScaledVector(v, SUB_DT);
    }
    return p.y;
  };
  let lo = 0, hi = 0.03;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid) > 0) hi = mid; else lo = mid;
  }
  const res = (lo + hi) / 2;
  zeroCache.set(zeroDist, res);
  return res;
}

/** Reine Flugzeit-/Fallberechnung fuer HUD-Hilfen (leicht). */
export function dropAt(distance: number, zeroDist: number): { dropMil: number; time: number } {
  const ang = zeroAngle(zeroDist);
  const v = new THREE.Vector3(Math.cos(ang) * RIFLE.muzzleVelocity, Math.sin(ang) * RIFLE.muzzleVelocity, 0);
  const p = new THREE.Vector3(0, -RIFLE.sightHeight, 0);
  const a = new THREE.Vector3(), zero = new THREE.Vector3();
  let t = 0;
  while (p.x < distance && t < 4) {
    accel(v, zero, a);
    v.addScaledVector(a, SUB_DT);
    p.addScaledVector(v, SUB_DT);
    t += SUB_DT;
  }
  return { dropMil: (p.y / distance) * 1000, time: t };
}
