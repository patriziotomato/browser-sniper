import * as THREE from 'three';
import { createNoise2D, NoiseFunction2D } from 'simplex-noise';
import { Rng, smoothstep } from '../core/rng';
import { settings } from '../config';

/**
 * Prozeduraler Berg. Der Spieler steht auf einem Grat bei (0, h, 0) und blickt nach -Z
 * ueber ein Tal auf den gegenueberliegenden Hang, auf dem die Gegner stehen.
 */
export interface TerrainParams {
  ridgeHeight: number;
  valleyFloor: number;
  valleyStart: number;
  valleyEnd: number;
  farRidgeDist: number;
  farRidgeHeight: number;
  lateralAmp: number;
  lateralPhase: number;
}

export class Terrain {
  readonly params: TerrainParams;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private n1: NoiseFunction2D;
  private n2: NoiseFunction2D;
  private n3: NoiseFunction2D;

  constructor(rng: Rng) {
    this.params = {
      ridgeHeight: rng.range(105, 145),
      valleyFloor: rng.range(30, 70),
      valleyStart: rng.range(100, 160),
      valleyEnd: rng.range(190, 260),
      farRidgeDist: rng.range(650, 820),
      farRidgeHeight: rng.range(170, 230),
      lateralAmp: rng.range(25, 55),
      lateralPhase: rng.range(0, Math.PI * 2),
    };
    const seedFn = () => rng.next();
    this.n1 = createNoise2D(seedFn);
    this.n2 = createNoise2D(seedFn);
    this.n3 = createNoise2D(seedFn);

    const geo = this.buildGeometry();
    this.material = createTerrainMaterial();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  private fbm(n: NoiseFunction2D, x: number, z: number, oct: number): number {
    let a = 1, f = 1, s = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * n(x * f, z * f);
      norm += a;
      a *= 0.5;
      f *= 2.03;
    }
    return s / norm;
  }

  heightAt(x: number, z: number): number {
    const p = this.params;
    const d = -z; // Distanz Richtung Gegner
    // Grat des Spielers (entlang X), faellt nach vorne ins Tal und hinten leicht ab.
    const ridgeFront = 1 - smoothstep(0, p.valleyStart, d);
    const ridgeBack = d < 0 ? Math.exp(-((d / 520) ** 2)) : 1;
    const lateral = Math.sin(x / 340 + p.lateralPhase) * p.lateralAmp;
    let h = p.valleyFloor + (p.ridgeHeight - p.valleyFloor + lateral * 0.6) * (d < 0 ? ridgeBack : ridgeFront);
    // Gegenhang steigt vom Talboden zum fernen Grat an.
    const rise = smoothstep(p.valleyEnd, p.farRidgeDist, d);
    h += (p.farRidgeHeight - p.valleyFloor + lateral) * rise;
    // Jenseits des Gegengrats geht es weiter in hohe Berge (Horizont).
    const cx = x, cz = z + 450;
    const r = Math.sqrt(cx * cx + cz * cz);
    h += 650 * smoothstep(1500, 2700, r) * (0.6 + 0.4 * this.fbm(this.n3, x / 900, z / 900, 3));
    // Grosse und mittlere Formen, Detail.
    h += 38 * this.fbm(this.n1, x / 650, z / 650, 4);
    const ridged = 1 - Math.abs(this.n2(x / 260, z / 260));
    h += 14 * ridged * ridged * (0.4 + rise);
    h += 2.2 * this.n3(x / 34, z / 34) + 0.6 * this.n1(x / 9, z / 9);
    return h;
  }

  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 1.0;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  slopeAt(x: number, z: number): number {
    return 1 - this.normalAt(x, z).y;
  }

  /** Sichtlinie gegen das Terrain pruefen (true = frei). */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3, clearance = 0.3): boolean {
    const dist = a.distanceTo(b);
    const steps = Math.ceil(dist / 3);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      if (this.heightAt(x, z) + clearance > y) return false;
    }
    return true;
  }

  private buildGeometry(): THREE.BufferGeometry {
    // Nicht-uniformes Gitter: dicht im Spielbereich, grob am Horizont.
    const axis = (segs: [number, number, number][]) => {
      const out: number[] = [];
      for (const [a, b, step] of segs) {
        const n = Math.max(1, Math.round((b - a) / step));
        for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / n);
      }
      out.push(segs[segs.length - 1][1]);
      return out;
    };
    const f = settings.quality.terrainStep / 2;
    const xs = axis([[-3400, -700, 45 * f], [-700, -320, 9 * f], [-320, 320, 2 * f], [320, 700, 9 * f], [700, 3400, 45 * f]]);
    const zs = axis([[-3800, -1350, 45 * f], [-1350, -1050, 8 * f], [-1050, 70, 2 * f], [70, 320, 6 * f], [320, 2600, 45 * f]]);
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    let k = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = xs[i], z = zs[j];
        pos[k++] = x;
        pos[k++] = this.heightAt(x, z);
        pos[k++] = z;
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    k = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

const GLSL_NOISE = /* glsl */ `
float tHash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float tNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(tHash(i), tHash(i+vec2(1,0)), u.x), mix(tHash(i+vec2(0,1)), tHash(i+vec2(1,1)), u.x), u.y);
}
float tFbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*tNoise(p); p*=2.07; a*=0.5; } return s; }
`;

function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;\nvarying vec3 vTNrm;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvTPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvTNrm = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;\nvarying vec3 vTNrm;\n' + GLSL_NOISE)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          vec2 p = vTPos.xz;
          float slope = 1.0 - normalize(vTNrm).y;
          float big = tFbm(p*0.004);
          float mid = tFbm(p*0.05);
          float fine = tFbm(p*0.9);
          float micro = tNoise(p*6.0);
          vec3 grassA = vec3(0.155,0.19,0.075);
          vec3 grassB = vec3(0.27,0.255,0.12);
          vec3 grass = mix(grassA, grassB, smoothstep(0.35,0.75,big*0.6+mid*0.6));
          grass *= 0.78 + 0.35*fine + 0.12*micro;
          vec3 dirt = vec3(0.26,0.21,0.15) * (0.8+0.4*fine);
          vec3 rock = mix(vec3(0.33,0.32,0.30), vec3(0.47,0.45,0.42), mid) * (0.7+0.45*fine) * (0.9+0.2*micro);
          vec3 snow = vec3(0.86,0.88,0.92) * (0.95+0.05*fine);
          float dirtW = smoothstep(0.55,0.8, mid + 0.25*fine) * 0.7 + smoothstep(0.18,0.3,slope)*0.5;
          vec3 col = mix(grass, dirt, clamp(dirtW,0.0,1.0));
          float rockW = smoothstep(0.30, 0.45, slope + (mid-0.5)*0.18);
          col = mix(col, rock, rockW);
          float snowW = smoothstep(480.0, 560.0, vTPos.y + big*80.0) * (1.0 - smoothstep(0.45,0.65,slope));
          col = mix(col, snow, snowW);
          diffuseColor.rgb = col;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = 0.97;',
      );
  };
  return mat;
}
