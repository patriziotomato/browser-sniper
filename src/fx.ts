import * as THREE from 'three';
import { dustTexture, glowTexture } from './world/textures';

interface Puff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  vel: THREE.Vector3;
  grow: number;
  baseOpacity: number;
}

export class Fx {
  private puffs: Puff[] = [];
  private dustTex = dustTexture();
  readonly glowTex = glowTexture();
  private traces: { line: THREE.Line; age: number }[] = [];

  constructor(private scene: THREE.Scene) {}

  private spawn(pos: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life: number, vel: THREE.Vector3, opacity: number, additive = false, tex = this.dustTex) {
    const mat = new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: !additive });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    this.scene.add(s);
    this.puffs.push({ sprite: s, age: 0, life, vel, grow: size * 1.8, baseOpacity: opacity });
  }

  /** Einschlag im Boden / an Material. Gut sichtbar durchs Zielfernrohr, um Schuesse zu korrigieren. */
  impact(pos: THREE.Vector3, normal: THREE.Vector3, kind: 'erde' | 'stein' | 'holz' | 'metall' | 'blaetter' | 'koerper', wind: THREE.Vector3) {
    const color = { erde: 0x8a7458, stein: 0xb0aaa0, holz: 0x9c7a50, metall: 0xfff2c0, blaetter: 0x5c6b35, koerper: 0x6a1010 }[kind];
    const n = kind === 'koerper' ? 6 : 10;
    for (let i = 0; i < n; i++) {
      const v = normal.clone().multiplyScalar(1.5 + Math.random() * 2.5).add(new THREE.Vector3((Math.random() - 0.5) * 1.6, Math.random() * 1.6, (Math.random() - 0.5) * 1.6)).addScaledVector(wind, 0.25);
      this.spawn(pos.clone().addScaledVector(normal, 0.1), color, kind === 'koerper' ? 0.35 : 0.5 + Math.random() * 0.5, 1.4 + Math.random() * 1.2, v, kind === 'koerper' ? 0.55 : 0.75);
    }
    if (kind === 'metall' || kind === 'stein') this.spawn(pos, 0xffe8b0, 0.6, 0.08, new THREE.Vector3(), 1, true, this.glowTex);
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, big = 1) {
    this.spawn(pos.clone().addScaledVector(dir, 0.3), 0xffc070, 0.9 * big, 0.06, new THREE.Vector3(), 1, true, this.glowTex);
    for (let i = 0; i < 4; i++) {
      this.spawn(pos.clone().addScaledVector(dir, 0.4 + i * 0.25), 0xb0aaa0, 0.4 + i * 0.15, 0.9 + Math.random(), dir.clone().multiplyScalar(1 + Math.random()).add(new THREE.Vector3(0, 0.3, 0)), 0.35);
    }
  }

  /** Rauch (z. B. Lagerfeuer) treibt mit dem Wind: ablesbarer Windindikator. */
  smoke(pos: THREE.Vector3, wind: THREE.Vector3) {
    const v = new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.9 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3).addScaledVector(wind, 0.55);
    const p: Puff = {
      sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dustTex, color: 0x9a9690, transparent: true, opacity: 0.4, depthWrite: false })),
      age: 0, life: 7 + Math.random() * 3, vel: v, grow: 0.9, baseOpacity: 0.4,
    };
    p.sprite.position.copy(pos);
    p.sprite.scale.setScalar(0.6);
    this.scene.add(p.sprite);
    this.puffs.push(p);
  }

  /** Staub, der vom Wind ueber den Boden getragen wird. */
  dustDrift(pos: THREE.Vector3, wind: THREE.Vector3) {
    this.spawn(pos, 0xb8a888, 1.5 + Math.random() * 2, 3 + Math.random() * 2, wind.clone().multiplyScalar(0.9).setY(0.15), 0.12);
  }

  trace(points: THREE.Vector3[]) {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.scene.add(line);
    this.traces.push({ line, age: 0 });
  }

  update(dt: number) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.puffs.splice(i, 1);
        continue;
      }
      if (p.life < 4) {
        p.vel.y -= 1.5 * dt;
        p.vel.multiplyScalar(Math.exp(-2.5 * dt));
      }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.sprite.scale.setScalar(p.sprite.scale.x + p.grow * dt * (1 - t));
      p.sprite.material.opacity = p.baseOpacity * (1 - t) * (1 - t);
    }
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const tr = this.traces[i];
      tr.age += dt;
      (tr.line.material as THREE.LineBasicMaterial).opacity = 0.35 * Math.max(0, 1 - tr.age / 2.5);
      if (tr.age > 2.5) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose();
        this.traces.splice(i, 1);
      }
    }
  }
}
