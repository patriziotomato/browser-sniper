import * as THREE from 'three';
import { Terrain } from './terrain';

/**
 * Vorberechnete Bodenbeleuchtung fuer das Spielgebiet:
 * R = Sonne nicht vom Gelaende verdeckt, G = Sonne nicht von Baeumen verdeckt, B = Umgebungsverdeckung.
 * Echtzeit-Schatten decken nur die Umgebung des Blickpunkts ab; diese Karte liefert den Rest.
 */
export class GroundLight {
  static readonly X0 = -2000;
  static readonly Z0 = -2600;
  static readonly W = 4000;
  static readonly D = 3500;
  private readonly res = 4;
  private readonly nx = GroundLight.W / this.res;
  private readonly nz = GroundLight.D / this.res;
  private sun: Float32Array;
  private tree: Float32Array;
  private ao: Float32Array;
  private sunXZ: THREE.Vector2;
  private cotElev: number;

  constructor(terrain: Terrain, sunDir: THREE.Vector3) {
    const n = this.nx * this.nz;
    this.tree = new Float32Array(n).fill(1);
    this.ao = new Float32Array(n).fill(1);
    this.sunXZ = new THREE.Vector2(sunDir.x, sunDir.z).normalize();
    this.cotElev = Math.hypot(sunDir.x, sunDir.z) / Math.max(sunDir.y, 0.02);
    this.sun = this.bakeTerrain(terrain);
  }

  /** Gelaendeschatten per Strahlverfolgung ueber ein grobes Hoehenraster. */
  private bakeTerrain(terrain: Terrain): Float32Array {
    // Hoehenraster ueber das ganze Gelaende (16 m)
    const HX0 = -3400, HZ0 = -3800, HS = 16;
    const hnx = Math.floor(6800 / HS) + 1, hnz = Math.floor(6400 / HS) + 1;
    const hg = new Float32Array(hnx * hnz);
    let maxH = -Infinity;
    for (let j = 0; j < hnz; j++) {
      for (let i = 0; i < hnx; i++) {
        const h = terrain.heightAt(HX0 + i * HS, HZ0 + j * HS);
        hg[j * hnx + i] = h;
        if (h > maxH) maxH = h;
      }
    }
    const hAt = (x: number, z: number) => {
      const fx = Math.min(Math.max((x - HX0) / HS, 0), hnx - 1.001);
      const fz = Math.min(Math.max((z - HZ0) / HS, 0), hnz - 1.001);
      const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
      const a = hg[j * hnx + i], b = hg[j * hnx + i + 1], c = hg[(j + 1) * hnx + i], d = hg[(j + 1) * hnx + i + 1];
      return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
    };

    // Sichtbarkeit auf 8-m-Raster berechnen, danach auf die Kartenaufloesung hochrechnen
    const CS = 8;
    const cnx = GroundLight.W / CS + 1, cnz = GroundLight.D / CS + 1;
    const coarse = new Float32Array(cnx * cnz);
    const sx = this.sunXZ.x, sz = this.sunXZ.y;
    const tanE = 1 / this.cotElev;
    const soft = 0.035;
    for (let j = 0; j < cnz; j++) {
      for (let i = 0; i < cnx; i++) {
        const x = GroundLight.X0 + i * CS, z = GroundLight.Z0 + j * CS;
        const h0 = hAt(x, z) + 2.5;
        let minSlack = Infinity;
        for (let t = 12; t < 4500;) {
          const rayH = h0 + t * tanE;
          if (rayH > maxH) break;
          const slack = (rayH - hAt(x + sx * t, z + sz * t)) / t;
          if (slack < minSlack) {
            minSlack = slack;
            if (minSlack < -soft) break;
          }
          t += Math.max(8, t * 0.06);
        }
        const v = minSlack === Infinity ? 1 : THREE.MathUtils.smoothstep(minSlack, -soft, soft);
        coarse[j * cnx + i] = v;
      }
    }
    const out = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      const fz = ((j + 0.5) * this.res) / CS;
      const cj = Math.min(fz | 0, cnz - 2), tz = fz - cj;
      for (let i = 0; i < this.nx; i++) {
        const fx = ((i + 0.5) * this.res) / CS;
        const ci = Math.min(fx | 0, cnx - 2), tx = fx - ci;
        const a = coarse[cj * cnx + ci], b = coarse[cj * cnx + ci + 1], c = coarse[(cj + 1) * cnx + ci], d = coarse[(cj + 1) * cnx + ci + 1];
        out[j * this.nx + i] = (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
      }
    }
    return out;
  }

  /** Nadelbaum: kegelfoermiger Schatten in Sonnenrichtung und dunklerer Boden unter der Krone. */
  addTree(x: number, z: number, height: number) {
    const res = this.res;
    const crown = height * 0.26 + 0.6;
    const len = Math.min(height * this.cotElev, 140);
    const sx = -this.sunXZ.x, sz = -this.sunXZ.y; // Schatten faellt von der Sonne weg
    const p0x = x + sx * len * 0.12, p0z = z + sz * len * 0.12;
    const segX = sx * len * 0.88, segZ = sz * len * 0.88;
    const segLen2 = Math.max(1e-3, segX * segX + segZ * segZ);
    const aoR = crown * 1.7;
    const minX = Math.min(x - aoR, p0x + Math.min(0, segX) - crown);
    const maxX = Math.max(x + aoR, p0x + Math.max(0, segX) + crown);
    const minZ = Math.min(z - aoR, p0z + Math.min(0, segZ) - crown);
    const maxZ = Math.max(z + aoR, p0z + Math.max(0, segZ) + crown);
    const i0 = Math.max(0, Math.floor((minX - GroundLight.X0) / res)), i1 = Math.min(this.nx - 1, Math.ceil((maxX - GroundLight.X0) / res));
    const j0 = Math.max(0, Math.floor((minZ - GroundLight.Z0) / res)), j1 = Math.min(this.nz - 1, Math.ceil((maxZ - GroundLight.Z0) / res));
    for (let j = j0; j <= j1; j++) {
      const wz = GroundLight.Z0 + (j + 0.5) * res;
      for (let i = i0; i <= i1; i++) {
        const wx = GroundLight.X0 + (i + 0.5) * res;
        const k = j * this.nx + i;
        // Schattenkegel
        const rx = wx - p0x, rz = wz - p0z;
        const u = Math.min(1, Math.max(0, (rx * segX + rz * segZ) / segLen2));
        const dx = rx - segX * u, dz = rz - segZ * u;
        const d = Math.sqrt(dx * dx + dz * dz);
        const w = crown * (1 - u * 0.92) + 0.8;
        if (d < w) {
          const dens = 0.72 * (1 - THREE.MathUtils.smoothstep(d, w * 0.45, w));
          this.tree[k] *= 1 - dens;
        }
        // Verdeckung unter der Krone
        const ad = Math.hypot(wx - x, wz - z);
        if (ad < aoR) this.ao[k] *= 1 - 0.42 * (1 - THREE.MathUtils.smoothstep(ad, aoR * 0.25, aoR));
      }
    }
  }

  private blur(src: Float32Array, passes: number) {
    const { nx, nz } = this;
    const tmp = new Float32Array(src.length);
    for (let p = 0; p < passes; p++) {
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          tmp[k] = (src[k] * 2 + src[i > 0 ? k - 1 : k] + src[i < nx - 1 ? k + 1 : k]) * 0.25;
        }
      }
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          src[k] = (tmp[k] * 2 + tmp[j > 0 ? k - nx : k] + tmp[j < nz - 1 ? k + nx : k]) * 0.25;
        }
      }
    }
  }

  /** Karte als Textur fertigstellen und in die globalen Uniforms legen. */
  finish(): THREE.DataTexture {
    this.blur(this.tree, 1);
    this.blur(this.ao, 2);
    const n = this.nx * this.nz;
    const data = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) {
      data[k * 4] = Math.round(this.sun[k] * 255);
      data[k * 4 + 1] = Math.round(Math.max(0.18, this.tree[k]) * 255);
      data[k * 4 + 2] = Math.round(Math.max(0.4, this.ao[k]) * 255);
      data[k * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, this.nx, this.nz, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  static rect(): THREE.Vector4 {
    return new THREE.Vector4(GroundLight.X0, GroundLight.Z0, 1 / GroundLight.W, 1 / GroundLight.D);
  }

}
