import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { bushCardTexture, logEndTexture, planksTexture, rockTexture, rustTexture, barkTexture } from './textures';

export type CoverKind = 'busch' | 'fels' | 'huette' | 'holzstapel' | 'autowrack';

export interface CoverDef {
  kind: CoverKind;
  label: string;
  group: THREE.Group;
  /** Multiplikator fuer die Entdeckungsgeschwindigkeit (kleiner = besser getarnt). */
  camo: number;
  /** Wahrscheinlichkeit, dass ein Schuss auf die geduckte Position durchschlaegt. */
  penetration: number;
  /** Augenposition beim Zielen / geduckt (lokal, Deckung schaut nach -Z). */
  aimEye: THREE.Vector3;
  duckEye: THREE.Vector3;
  /** Material, das bei Einschlaegen splittert. */
  impact: 'blaetter' | 'stein' | 'holz' | 'metall';
  hint: string;
}

const COVER_INFO: Record<CoverKind, Omit<CoverDef, 'group' | 'kind'>> = {
  busch: { label: 'Busch', camo: 0.55, penetration: 0.35, aimEye: new THREE.Vector3(0, 1.38, 0.35), duckEye: new THREE.Vector3(0, 0.72, 1.15), impact: 'blaetter', hint: 'Gut getarnt, aber Kugeln gehen durch.' },
  fels: { label: 'Felsblock', camo: 0.85, penetration: 0, aimEye: new THREE.Vector3(0, 1.45, 0.3), duckEye: new THREE.Vector3(0, 0.75, 1.35), impact: 'stein', hint: 'Voller Schutz, deine Silhouette faellt auf.' },
  huette: { label: 'Holzhuette', camo: 0.5, penetration: 0, aimEye: new THREE.Vector3(0, 1.36, -0.98), duckEye: new THREE.Vector3(0, 0.8, -1.0), impact: 'holz', hint: 'Enges Fenster, du sitzt im Schatten.' },
  holzstapel: { label: 'Holzstapel', camo: 0.8, penetration: 0.12, aimEye: new THREE.Vector3(0, 1.35, 0.35), duckEye: new THREE.Vector3(0, 0.7, 1.05), impact: 'holz', hint: 'Dickes Holz haelt meistens.' },
  autowrack: { label: 'Autowrack', camo: 1.15, penetration: 0, aimEye: new THREE.Vector3(2.45, 1.3, 0.35), duckEye: new THREE.Vector3(1.6, 0.72, 1.4), impact: 'metall', hint: 'Voller Schutz, Metall reflektiert.' },
};

export function buildCover(kind: CoverKind, rng: Rng): CoverDef {
  const group = new THREE.Group();
  switch (kind) {
    case 'busch': buildBush(group, rng); break;
    case 'fels': buildRock(group, rng); break;
    case 'huette': buildHut(group); break;
    case 'holzstapel': buildWoodpile(group, rng); break;
    case 'autowrack': buildCar(group); break;
  }
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const info = COVER_INFO[kind];
  return { kind, group, ...info, aimEye: info.aimEye.clone(), duckEye: info.duckEye.clone() };
}

function buildBush(g: THREE.Group, rng: Rng) {
  const map = bushCardTexture();
  const mat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9, color: 0xb8c49a });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.4 });
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 110; i++) {
    const s = rng.range(0.7, 1.2);
    const p = new THREE.PlaneGeometry(s, s);
    p.rotateY(rng.range(0, Math.PI));
    p.rotateX(rng.range(-0.6, 0.6));
    const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next());
    const x = Math.cos(a) * r * 1.5, z = Math.sin(a) * r * 0.75 - 0.15;
    let y = rng.range(0.25, 1.2) * (1 - r * 0.35);
    if (Math.abs(x) < 0.7) y = Math.min(y, 0.72);
    p.translate(x, y, z);
    parts.push(p);
  }
  const geo = mergeGeometries(parts)!;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i) - 0.3, pos.getZ(i)).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.customDepthMaterial = depth;
  g.add(mesh);
}

function buildRock(g: THREE.Group, rng: Rng) {
  const geo = new THREE.IcosahedronGeometry(1, 5);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const seed = rng.range(0, 50);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + 0.12 * Math.sin(v.x * 4 + seed) * Math.cos(v.y * 3.3 + seed) + 0.05 * Math.sin(v.z * 11 + seed * 2) + 0.025 * Math.sin(v.x * 23 + v.y * 19);
    v.multiplyScalar(n);
    p.setXYZ(i, v.x * 1.35, v.y * 0.66, v.z * 0.95);
  }
  geo.computeVertexNormals();
  const map = rockTexture();
  map.repeat.set(2, 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, roughness: 0.92, color: 0xd0ccc4 }));
  mesh.position.set(0, 0.33, 0);
  g.add(mesh);
}

function buildHut(g: THREE.Group) {
  const pm = planksTexture();
  pm.repeat.set(1.5, 1.2);
  const wood = new THREE.MeshStandardMaterial({ map: pm, roughness: 0.9 });
  const darkWood = new THREE.MeshStandardMaterial({ map: pm, roughness: 0.95, color: 0x6b5a4a });
  const W = 3.2, D = 3.2, H = 2.3, T = 0.12;
  const sill = 1.0, winTop = 1.7, winW = 1.6;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m = wood) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    g.add(b);
    return b;
  };
  // Fundament (gleicht Hang aus)
  box(W + 0.3, 2.5, D + 0.3, 0, -1.2, 0, darkWood);
  box(W, 0.08, D, 0, 0.04, 0, darkWood);
  // Vorderwand mit Fenster (Richtung -Z)
  const fz = -D / 2;
  const side = (W - winW) / 2;
  box(side, H, T, -W / 2 + side / 2, H / 2, fz);
  box(side, H, T, W / 2 - side / 2, H / 2, fz);
  box(winW, sill, T, 0, sill / 2, fz);
  box(winW, H - winTop, T, 0, winTop + (H - winTop) / 2, fz);
  // Fensterrahmen
  box(winW + 0.1, 0.06, 0.2, 0, sill, fz, darkWood);
  // Seiten und Rueckwand (mit Tuer)
  box(T, H, D, -W / 2, H / 2, 0);
  box(T, H, D, W / 2, H / 2, 0);
  box(W / 2 - 0.45, H, T, -W / 4 - 0.22, H / 2, D / 2);
  box(W / 2 - 0.45, H, T, W / 4 + 0.22, H / 2, D / 2);
  box(0.9, H - 1.95, T, 0, 1.95 + (H - 1.95) / 2, D / 2);
  // Satteldach
  const roofLen = Math.hypot(W / 2 + 0.35, 0.9);
  const roofAng = Math.atan2(0.9, W / 2 + 0.35);
  for (const s of [-1, 1]) {
    const r = box(roofLen, 0.08, D + 0.6, s * (W / 4 + 0.08), H + 0.45, 0, darkWood);
    r.rotation.z = -s * roofAng;
  }
  // Giebel
  const gable = new THREE.Shape();
  gable.moveTo(-W / 2, 0); gable.lineTo(W / 2, 0); gable.lineTo(0, 0.9); gable.closePath();
  const gGeo = new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false });
  for (const z of [-D / 2 - T / 2, D / 2 - T / 2]) {
    const m = new THREE.Mesh(gGeo, wood);
    m.position.set(0, H, z);
    g.add(m);
  }
  // Kiste innen
  box(0.6, 0.45, 0.5, -1.0, 0.3, 0.7, darkWood);
}

function buildWoodpile(g: THREE.Group, rng: Rng) {
  const bm = barkTexture();
  bm.repeat.set(3, 1);
  const bark = new THREE.MeshStandardMaterial({ map: bm, roughness: 1, color: 0xd9c4a8 });
  const end = new THREE.MeshStandardMaterial({ map: logEndTexture(), roughness: 0.9 });
  const rows = [5, 4, 3];
  const r = 0.17;
  rows.forEach((n, row) => {
    for (let i = 0; i < n; i++) {
      const len = 2.8 + rng.range(-0.15, 0.15);
      const geo = new THREE.CylinderGeometry(r * rng.range(0.85, 1.1), r * rng.range(0.85, 1.1), len, 12);
      const m = new THREE.Mesh(geo, [bark, end, end]);
      m.rotation.z = Math.PI / 2;
      m.rotation.y = rng.range(-0.03, 0.03);
      const x0 = -((n - 1) * r * 2) / 2;
      m.position.set(rng.range(-0.08, 0.08), r + row * r * 1.75, x0 + i * r * 2.02 - 0.1);
      g.add(m);
    }
  });
  // Stuetzpfosten
  for (const z of [-0.95, 0.75]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.1), bark);
    post.position.set(1.1, 0.6, z);
    g.add(post);
    const post2 = post.clone();
    post2.position.x = -1.1;
    g.add(post2);
  }
}

function buildCar(g: THREE.Group) {
  const rm = rustTexture();
  rm.repeat.set(2, 1);
  const rust = new THREE.MeshStandardMaterial({ map: rm, roughness: 0.8, metalness: 0.2, color: 0xe6d6c0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.3, metalness: 0.2 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.95 });
  // Karosserie laengs zu X, Breitseite Richtung Gegner
  const body = new THREE.Mesh(new RoundedBoxGeometry(4.3, 0.62, 1.8, 4, 0.12), rust);
  body.position.set(0, 0.62, 0);
  body.rotation.z = 0.04;
  g.add(body);
  const cabin = new THREE.Mesh(new RoundedBoxGeometry(2.1, 0.55, 1.62, 4, 0.14), rust);
  cabin.position.set(-0.45, 1.18, 0);
  g.add(cabin);
  // Scheiben (zerbrochen dunkel)
  for (const z of [-0.82, 0.82]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.38), dark);
    w.position.set(-0.45, 1.2, z);
    if (z > 0) w.rotation.y = Math.PI;
    g.add(w);
  }
  // Reifen platt
  for (const x of [-1.35, 1.35]) for (const z of [-0.82, 0.82]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 16), tire);
    t.rotation.x = Math.PI / 2;
    t.scale.set(1, 1, 0.85);
    t.position.set(x, 0.26, z);
    g.add(t);
  }
}
