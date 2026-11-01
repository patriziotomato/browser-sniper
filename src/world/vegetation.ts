import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { Terrain } from './terrain';
import { settings } from '../config';
const V = () => settings.quality.vegetation;
const GR = () => settings.quality.grass;
import { barkTexture, branchCardTexture, bushCardTexture, grassCardTexture, rockTexture } from './textures';

export const windUniforms = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(0, 0) },
};

/** Wind-Biegung in den Vertex-Shader einbauen. bendExpr liefert 0..1 (wie stark der Vertex mitgeht). */
function addWind(mat: THREE.Material, bendExpr: string, strength: number) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uWind;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          vec3 iPos = vec3(0.0);
          #ifdef USE_INSTANCING
            iPos = instanceMatrix[3].xyz;
          #endif
          float bend = ${bendExpr};
          float w = length(uWind);
          float gust = 0.6 + 0.4*sin(uTime*1.3 + iPos.x*0.05 + iPos.z*0.04);
          float flutter = sin(uTime*(2.0+w*0.35) + iPos.x*0.7 + iPos.z*0.3 + position.y*2.0);
          vec2 dir = w > 0.01 ? uWind / w : vec2(1.0, 0.0);
          float amt = bend * ${strength.toFixed(3)} * (w*gust*0.08 + flutter*0.02*(0.3+w*0.1));
          transformed.x += dir.x * amt;
          transformed.z += dir.y * amt;
        }`,
      );
  };
}

/** Normalen radial nach aussen (wirkt bei Karten-Vegetation wie ein Volumen). centerY < 0 = Achse (Baum). */
function outwardNormals(geo: THREE.BufferGeometry, centerY: number, upBias: number) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const dy = centerY < 0 ? Math.hypot(x, z) * upBias + 0.08 : pos.getY(i) - centerY + upBias;
    v.set(x, dy, z).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
}

function buildConifer(rng: Rng, height: number): { trunk: THREE.BufferGeometry; foliage: THREE.BufferGeometry } {
  const trunk = new THREE.CylinderGeometry(0.07 * height / 10, 0.022 * height + 0.12, height, 7, 1, true);
  trunk.translate(0, height / 2, 0);
  const cards: THREE.BufferGeometry[] = [];
  const crownStart = height * rng.range(0.12, 0.22);
  const whorls = Math.round(height * 1.15);
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y = crownStart + (height - crownStart) * t;
    const len = (height * 0.32) * Math.pow(1 - t, 0.85) + 0.35;
    const per = 4 + Math.round((1 - t) * 2);
    for (let b = 0; b < per; b++) {
      const ang = (b / per) * Math.PI * 2 + rng.range(-0.3, 0.3) + w * 0.7;
      const droop = rng.range(0.15, 0.45) + t * 0.1;
      for (let k = 0; k < 2; k++) {
        const g = new THREE.PlaneGeometry(len, len * 0.55);
        g.translate(len / 2, 0, 0);
        g.rotateX(k === 0 ? Math.PI / 2 : rng.range(-0.25, 0.25));
        g.rotateZ(-droop);
        g.rotateY(ang);
        g.translate(0, y, 0);
        cards.push(g);
      }
    }
  }
  const top = new THREE.PlaneGeometry(0.9, 1.6);
  top.translate(0, height + 0.5, 0);
  cards.push(top, top.clone().rotateY(Math.PI / 2));
  const foliage = mergeGeometries(cards)!;
  outwardNormals(foliage, -1, 0.45);
  return { trunk, foliage };
}

export interface Exclusion {
  (x: number, z: number): boolean;
}

export class Vegetation {
  readonly group = new THREE.Group();

  constructor(private terrain: Terrain, private rng: Rng, private exclude: Exclusion, private grassExclude: Exclusion, enemyAreas: THREE.Vector3[], player: THREE.Vector3) {
    this.buildTrees();
    this.buildRocks();
    this.buildBushes();
    this.buildGrass(enemyAreas, player);
  }

  private scatter(count: number, area: { x: [number, number]; z: [number, number] }, accept: (x: number, z: number, h: number, slope: number) => boolean, maxTries = count * 8, exclude: Exclusion = this.exclude) {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < maxTries && out.length < count; i++) {
      const x = this.rng.range(area.x[0], area.x[1]);
      const z = this.rng.range(area.z[0], area.z[1]);
      if (exclude(x, z)) continue;
      const h = this.terrain.heightAt(x, z);
      const slope = this.terrain.slopeAt(x, z);
      if (!accept(x, z, h, slope)) continue;
      out.push(new THREE.Vector3(x, h, z));
    }
    return out;
  }

  private buildTrees() {
    const barkMap = barkTexture();
    barkMap.repeat.set(1, 3);
    const branchMap = branchCardTexture();
    const barkMat = new THREE.MeshStandardMaterial({ map: barkMap, roughness: 1 });
    const folMat = new THREE.MeshStandardMaterial({ map: branchMap, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.9 });
    addWind(folMat, 'clamp(position.y/12.0,0.0,1.0)', 1.0);
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: branchMap, alphaTest: 0.42 });

    // Waldflaechen ueber Rauschen: Baeume clustern, offene Wiesen dazwischen.
    const forestNoise = (x: number, z: number) =>
      Math.sin(x / 210 + this.terrain.params.lateralPhase) * Math.cos(z / 170) + Math.sin((x + z) / 90) * 0.4;
    const pos = this.scatter(
      Math.round(4200 * V()),
      { x: [-1700, 1700], z: [-2300, 800] },
      (x, z, h, slope) => slope < 0.38 && h < 470 && forestNoise(x, z) > 0.15 - Math.random() * 0.35,
      60000,
    );
    const variants = [9, 14, 19].map((hgt) => buildConifer(this.rng, hgt));
    // In Kacheln aufteilen, damit Frustum-Culling (Kamera und Schatten) greift
    const CELL = 450;
    const buckets = new Map<string, { vi: number; list: THREE.Vector3[] }>();
    pos.forEach((p, i) => {
      const vi = i % 3;
      const key = `${vi}_${Math.floor(p.x / CELL)}_${Math.floor(p.z / CELL)}`;
      if (!buckets.has(key)) buckets.set(key, { vi, list: [] });
      buckets.get(key)!.list.push(p);
    });
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), e = new THREE.Euler();
    const col = new THREE.Color();
    buckets.forEach(({ vi, list }) => {
      const v = variants[vi];
      const trunk = new THREE.InstancedMesh(v.trunk, barkMat, list.length);
      const fol = new THREE.InstancedMesh(v.foliage, folMat, list.length);
      fol.customDepthMaterial = depth;
      list.forEach((p, i) => {
        const sc = this.rng.range(0.7, 1.25);
        e.set(this.rng.range(-0.04, 0.04), this.rng.range(0, Math.PI * 2), this.rng.range(-0.04, 0.04));
        q.setFromEuler(e);
        s.set(sc, sc * this.rng.range(0.9, 1.15), sc);
        m.compose(new THREE.Vector3(p.x, p.y - 0.3, p.z), q, s);
        trunk.setMatrixAt(i, m);
        fol.setMatrixAt(i, m);
        col.setHSL(this.rng.range(0.22, 0.3), this.rng.range(0.25, 0.5), this.rng.range(0.32, 0.5));
        fol.setColorAt(i, col);
      });
      for (const im of [trunk, fol]) {
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    });
  }

  private buildRocks() {
    const map = rockTexture();
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95 });
    const geos = [0, 1, 2].map(() => {
      const g = new THREE.IcosahedronGeometry(1, 3);
      const p = g.attributes.position as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      const seed = this.rng.range(0, 100);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const n = 1 + 0.22 * Math.sin(v.x * 3 + seed) * Math.cos(v.z * 2.6 + seed) + 0.1 * Math.sin(v.y * 7 + seed);
        v.multiplyScalar(n);
        v.y = v.y < -0.2 ? -0.2 + (v.y + 0.2) * 0.3 : v.y * 0.75;
        p.setXYZ(i, v.x, v.y, v.z);
      }
      g.computeVertexNormals();
      return g;
    });
    const pos = this.scatter(Math.round(1800 * V()), { x: [-1400, 1400], z: [-1900, 500] }, (_x, _z, h, slope) => slope > 0.12 || Math.random() < 0.25, 20000);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    geos.forEach((g, gi) => {
      const list = pos.filter((_, i) => i % 3 === gi);
      const im = new THREE.InstancedMesh(g, mat, list.length);
      list.forEach((p, i) => {
        const sc = Math.pow(this.rng.next(), 2.2) * 3.2 + 0.35;
        e.set(this.rng.range(-0.3, 0.3), this.rng.range(0, 6.28), this.rng.range(-0.3, 0.3));
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(p.x, p.y + sc * 0.05, p.z), q, new THREE.Vector3(sc * this.rng.range(0.8, 1.5), sc, sc * this.rng.range(0.8, 1.4)));
        im.setMatrixAt(i, m);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    });
  }

  private bushGeometry(cards: number, radius: number) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < cards; i++) {
      const g = new THREE.PlaneGeometry(radius * 1.3, radius * 1.3);
      g.rotateY(this.rng.range(0, Math.PI));
      g.rotateX(this.rng.range(-0.5, 0.5));
      g.translate(this.rng.range(-0.45, 0.45) * radius, radius * this.rng.range(0.45, 0.95), this.rng.range(-0.45, 0.45) * radius);
      parts.push(g);
    }
    const geo = mergeGeometries(parts)!;
    outwardNormals(geo, radius * 0.5, 0.25);
    return geo;
  }

  private buildBushes() {
    const map = bushCardTexture();
    const mat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 });
    addWind(mat, 'clamp(position.y/1.5,0.0,1.0)', 0.5);
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.4 });
    const geo = this.bushGeometry(12, 1);
    const pos = this.scatter(Math.round(2600 * V()), { x: [-1100, 1100], z: [-1500, 400] }, (_x, _z, h, slope) => slope < 0.33 && h < 470, 30000);
    const im = new THREE.InstancedMesh(geo, mat, pos.length);
    im.customDepthMaterial = depth;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const col = new THREE.Color();
    pos.forEach((p, i) => {
      const sc = this.rng.range(0.5, 1.5);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng.range(0, 6.28));
      m.compose(p, q, new THREE.Vector3(sc, sc * this.rng.range(0.7, 1.1), sc));
      im.setMatrixAt(i, m);
      col.setHSL(this.rng.range(0.15, 0.27), 0.4, this.rng.range(0.38, 0.55));
      im.setColorAt(i, col);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    this.group.add(im);
  }

  private buildGrass(enemyAreas: THREE.Vector3[], player: THREE.Vector3) {
    const map = grassCardTexture();
    const mat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1 });
    addWind(mat, 'uv.y*uv.y', 1.6);
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(0.75, 0.55, 1, 2);
      g.translate(0, 0.27, 0);
      g.rotateY((i * Math.PI) / 3);
      parts.push(g);
    }
    const geo = mergeGeometries(parts)!;
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);

    const pts: THREE.Vector3[] = [];
    const around = (c: THREE.Vector3, r: number, n: number) => {
      for (let i = 0, tries = 0; i < n && tries < n * 3; tries++) {
        const a = this.rng.range(0, Math.PI * 2), d = Math.sqrt(this.rng.next()) * r;
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
        if (this.grassExclude(x, z)) continue;
        if (this.terrain.slopeAt(x, z) > 0.33) continue;
        pts.push(new THREE.Vector3(x, this.terrain.heightAt(x, z), z));
        i++;
      }
    };
    around(player, 55, Math.round(22000 * GR()));
    void enemyAreas;
    pts.push(...this.scatter(Math.round(12000 * GR()), { x: [player.x - 200, player.x + 200], z: [player.z - 230, player.z + 40] }, (_x, _z, h, slope) => slope < 0.3 && h < 460, 60000, this.grassExclude));

    const im = new THREE.InstancedMesh(geo, mat, pts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const col = new THREE.Color();
    pts.forEach((p, i) => {
      const sc = this.rng.range(0.6, 1.4);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng.range(0, 6.28));
      m.compose(new THREE.Vector3(p.x, p.y - 0.05, p.z), q, new THREE.Vector3(sc, sc * this.rng.range(0.7, 1.3), sc));
      im.setMatrixAt(i, m);
      col.setHSL(this.rng.range(0.14, 0.22), this.rng.range(0.25, 0.45), this.rng.range(0.7, 0.9));
      im.setColorAt(i, col);
    });
    im.receiveShadow = true;
    im.computeBoundingSphere();
    this.group.add(im);
  }
}
