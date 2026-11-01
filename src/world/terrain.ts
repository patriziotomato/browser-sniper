import * as THREE from 'three';
import { createNoise2D, NoiseFunction2D } from 'simplex-noise';
import { Rng, smoothstep } from '../core/rng';
import { settings } from '../config';
import { customize, matte } from './atmosphere';

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
    // Mulden (+) und Kuppen (-) aus den Nachbarhoehen: feuchte, dunkle Senken, trockene Grate
    const cav = new Float32Array(nx * nz);
    const H = (i: number, j: number) => pos[(Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))) * 3 + 1];
    // zwei Massstaebe mitteln, damit keine Dreiecksfacetten entstehen
    const curv = (i: number, j: number, k: number) => {
      const sx = (xs[Math.min(nx - 1, i + k)] - xs[Math.max(0, i - k)]) / 2;
      const sz = (zs[Math.min(nz - 1, j + k)] - zs[Math.max(0, j - k)]) / 2;
      return (H(i - k, j) + H(i + k, j) - 2 * H(i, j)) / Math.max(1, sx) + (H(i, j - k) + H(i, j + k) - 2 * H(i, j)) / Math.max(1, sz);
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const c = 0.35 * curv(i, j, 4) + 0.65 * curv(i, j, 9);
        cav[j * nx + i] = Math.max(-1, Math.min(1, c * 1.8));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCavity', new THREE.BufferAttribute(cav, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

export const GLSL_NOISE = /* glsl */ `
float tHash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float tNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(tHash(i), tHash(i+vec2(1,0)), u.x), mix(tHash(i+vec2(0,1)), tHash(i+vec2(1,1)), u.x), u.y);
}
const mat2 tRot = mat2(0.8, -0.6, 0.6, 0.8);
float tFbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*tNoise(p); p=tRot*p*2.07; a*=0.5; } return s/0.97; }
float tFbm3(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<3;i++){ s+=a*tNoise(p); p=tRot*p*2.07; a*=0.5; } return s/0.875; }

// Wiesenfarbe (linear). Wird vom Gras mitbenutzt, damit Halme und Boden zusammenpassen.
vec3 meadowColor(vec2 p, float cav, float slope, out float dry){
  float big = tFbm3(p*0.0032);
  float mid = tFbm3(p*0.021);
  float patchN = tFbm3(p*0.09 + 13.0);
  vec3 lush = vec3(0.052, 0.098, 0.022);
  vec3 green = vec3(0.105, 0.150, 0.035);
  vec3 olive = vec3(0.170, 0.170, 0.055);
  vec3 straw = vec3(0.190, 0.165, 0.070);
  dry = clamp(smoothstep(0.5, 0.95, big*0.7 + mid*0.35 + (patchN-0.5)*0.3 - cav*0.35 + slope*0.6), 0.0, 1.0);
  vec3 c = mix(lush, green, smoothstep(0.25, 0.65, mid + cav*0.4));
  c = mix(c, olive, smoothstep(0.45, 0.8, big + (patchN-0.5)*0.4) * 0.8);
  c = mix(c, straw, dry*0.75);
  return c;
}
`;

export const GLSL_BUMP = /* glsl */ `
vec3 tPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy) {
  // Unnormiert: Neigung = Hoehenaenderung pro Meter, unabhaengig von Zoom und Entfernung
  vec3 vSigmaX = dFdx(surf_pos);
  vec3 vSigmaY = dFdy(surf_pos);
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1);
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  customize(mat, 'terrain-v2', (shader) => {
    matte(shader, 0.25);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aCavity;\nvarying vec3 vTPos;\nvarying vec3 vTNrm;\nvarying float vCav;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvTPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvTNrm = normalize(mat3(modelMatrix) * objectNormal);\nvCav = aCavity;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;\nvarying vec3 vTNrm;\nvarying float vCav;\nfloat tBumpH;\n' + GLSL_NOISE + GLSL_BUMP)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          vec2 p = vTPos.xz;
          float slope = 1.0 - normalize(vTNrm).y;
          float cav = vCav;
          // Pixelgroesse in Metern: feine Muster ausblenden, bevor sie flimmern
          float px = length(fwidth(p));
          float wFine = 1.0 - smoothstep(0.25, 1.4, px);
          float wMicro = 1.0 - smoothstep(0.03, 0.22, px);
          float wMid = 1.0 - smoothstep(3.0, 14.0, px);
          float mid = tFbm(p*0.045);
          float fine = mix(0.5, tFbm(p*0.6), wFine);
          float micro = mix(0.5, tNoise(p*4.5), wMicro);
          float big = tFbm3(p*0.0032);

          float dry;
          vec3 grass = meadowColor(p, cav, slope, dry);
          grass *= 0.72 + 0.5*fine + 0.22*(micro-0.5);

          vec3 soil = mix(vec3(0.075, 0.05, 0.03), vec3(0.15, 0.105, 0.065), fine);
          float soilW = smoothstep(0.7, 0.85, tFbm3(p*0.08 + 5.0) + 0.3*(fine-0.5)) * 0.65 + smoothstep(0.2, 0.36, slope + (mid-0.5)*0.2) * 0.7;
          vec3 col = mix(grass, soil, clamp(soilW, 0.0, 1.0));

          // Fels mit Schichtung
          float wStrata = 1.0 - smoothstep(0.8, 2.6, fwidth(vTPos.y) + px * 0.25);
          float strata = mix(0.5, sin(vTPos.y*0.75 + tFbm3(p*0.02)*7.0) * 0.5 + 0.5, wStrata);
          vec3 rockA = vec3(0.13, 0.125, 0.115), rockB = vec3(0.30, 0.29, 0.265);
          vec3 rock = mix(rockA, rockB, clamp(strata*0.55 + mid*0.6 - 0.1, 0.0, 1.0));
          rock *= 0.72 + 0.42*fine + 0.15*(micro-0.5);
          rock = mix(rock, rock*vec3(0.9, 1.0, 0.75), smoothstep(0.55, 0.8, tFbm3(p*0.15))*0.5); // Flechten
          float rockW = smoothstep(0.30, 0.46, slope + (mid-0.5)*0.22 - cav*0.12);
          col = mix(col, rock, rockW);

          // Geroell am Hangfuss
          float scree = smoothstep(0.22, 0.32, slope) * (1.0 - rockW) * smoothstep(0.55, 0.75, tFbm3(p*0.3+3.0));
          col = mix(col, rockB*0.8*(0.7+0.6*micro), scree*0.6);

          // Hochgebirge: grosse Rinnen und Grate, Fels schaut aus dem Schnee
          float alpine = smoothstep(260.0, 520.0, vTPos.y);
          float gully = 1.0 - abs(tFbm3(p*vec2(0.006, 0.0045) + vec2(big)) * 2.0 - 1.0);
          float snowLine = 470.0 + big*90.0 - slope*60.0;
          float snowW = smoothstep(snowLine, snowLine + 50.0, vTPos.y) * (1.0 - smoothstep(0.38, 0.6, slope + (gully-0.5)*0.35 + (mid-0.5)*0.3));
          col = mix(col, vec3(0.56, 0.585, 0.63) * (0.9 + 0.14*fine), snowW);

          // Senken etwas dunkler
          col *= 1.0 - clamp(cav, 0.0, 1.0) * 0.25 + clamp(-cav, 0.0, 1.0) * 0.06;
          diffuseColor.rgb = col;

          // Relief fuer die Normalen (Meter)
          tBumpH = (mid * 1.6 * wMid + fine * 0.35 * wFine) * (0.35 + rockW * 1.6 + scree) * (1.0 - snowW*0.7)
                 + micro * 0.04 * wMicro
                 + gully * gully * 12.0 * alpine;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = tPerturb(-vViewPosition, normal, vec2(dFdx(tBumpH), dFdy(tBumpH)));',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = 0.96;',
      );
  });
  return mat;
}
