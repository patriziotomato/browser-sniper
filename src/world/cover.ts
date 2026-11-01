import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { alphaMipFix, customize, matte } from './atmosphere';
import { bushCardTexture, logEndTexture, planksTexture, rockTexture, barkTexture } from './textures';

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
  const mat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85, color: 0xc4ccaa });
  customize(mat, 'cover-bush', (shader) => {
    alphaMipFix(shader, 0.3);
    matte(shader, 0.45);
  });
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
  const wm = wreckTexture();
  wm.repeat.set(0.25, 0.25);
  const paint = new THREE.MeshStandardMaterial({ map: wm, roughness: 0.88, metalness: 0.15 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0c0f10, roughness: 0.12, metalness: 0.1, side: THREE.DoubleSide });
  const chrome = new THREE.MeshStandardMaterial({ color: 0x55534e, roughness: 0.55, metalness: 0.7 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95 });
  const under = new THREE.MeshStandardMaterial({ color: 0x1c1915, roughness: 1 });
  // Seitenprofil einer alten Limousine (Laenge laengs X, Front bei -X), mit Radlaeufen
  const B = 0.34, WR = 0.42;
  const prof = new THREE.Shape();
  prof.moveTo(-2.12, B);
  prof.lineTo(-2.2, 0.56);
  prof.quadraticCurveTo(-2.2, 0.84, -2.02, 0.87);
  prof.lineTo(-0.98, 0.97);
  prof.quadraticCurveTo(-0.62, 1.32, -0.32, 1.42);
  prof.quadraticCurveTo(0.2, 1.47, 0.78, 1.43);
  prof.quadraticCurveTo(1.12, 1.25, 1.36, 1.0);
  prof.lineTo(2.08, 0.95);
  prof.quadraticCurveTo(2.2, 0.9, 2.19, 0.58);
  prof.lineTo(2.12, B);
  prof.lineTo(1.35 + WR, B);
  prof.absarc(1.35, B, WR, 0, Math.PI, false);
  prof.lineTo(-1.35 + WR, B);
  prof.absarc(-1.35, B, WR, 0, Math.PI, false);
  prof.lineTo(-2.12, B);
  const bodyGeo = new THREE.ExtrudeGeometry(prof, { depth: 1.66, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 3, curveSegments: 10 });
  bodyGeo.translate(0, 0, -0.83);
  const body = new THREE.Mesh(bodyGeo, paint);
  // Front (niedrige Motorhaube) zeigt zur Schussposition bei +X
  body.scale.x = -1;
  body.position.y = -0.04;
  body.rotation.z = 0.035;
  body.rotation.x = -0.02;
  g.add(body);
  // Unterboden
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4.1, 0.12, 1.6), under);
  floor.position.set(0, B + 0.02, 0);
  body.add(floor);
  // Seitenscheiben (eine fehlt), Front- und Heckscheibe
  const win = new THREE.Shape();
  win.moveTo(-0.86, 1.02);
  win.quadraticCurveTo(-0.58, 1.3, -0.33, 1.36);
  win.quadraticCurveTo(0.2, 1.4, 0.74, 1.37);
  win.quadraticCurveTo(1.02, 1.22, 1.2, 1.02);
  win.lineTo(-0.86, 1.02);
  const winGeo = new THREE.ShapeGeometry(win, 8);
  for (const z of [-0.91, 0.91]) {
    const w = new THREE.Mesh(winGeo, glass);
    w.position.z = z;
    body.add(w);
  }
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.38, 1.86), paint);
  pillar.position.set(0.22, 1.2, 0);
  body.add(pillar);
  const slanted = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(len * 0.92, 1.5), glass);
    pl.rotation.order = 'ZYX';
    pl.rotation.z = Math.atan2(y1 - y0, x1 - x0);
    pl.rotation.x = -Math.PI / 2;
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    pl.position.set((x0 + x1) / 2 + nx * 0.075, (y0 + y1) / 2 + ny * 0.075, 0);
    body.add(pl);
  };
  slanted(-0.95, 0.99, -0.36, 1.4);
  slanted(0.8, 1.42, 1.33, 1.02);
  // Stossstangen, Scheinwerfer
  for (const x of [-2.27, 2.25]) {
    const bump = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.16, 1.82, 2, 0.04), chrome);
    bump.position.set(x, 0.5, 0);
    body.add(bump);
  }
  for (const z of [-0.6, 0.6]) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 14), chrome);
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(-2.22, 0.72, z);
    body.add(lamp);
  }
  // Reifen platt, Felgen
  for (const x of [-1.35, 1.35]) for (const z of [-0.74, 0.74]) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.11, 8, 18), tire);
    t.scale.set(1, 0.86, 1.1);
    t.position.set(x, 0.29, z);
    g.add(t);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 14), chrome);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(x, 0.29, z);
    g.add(rim);
  }
}

/** Verblasster Lack mit Rostflecken und Laufspuren. */
function wreckTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  const r = (a: number, b: number) => a + Math.random() * (b - a);
  g.fillStyle = '#56605a';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2500; i++) {
    const v = r(-16, 16);
    g.fillStyle = `rgba(${86 + v},${96 + v},${90 + v},0.25)`;
    g.fillRect(r(0, 512), r(0, 512), r(2, 10), r(2, 10));
  }
  // Ausgebleichte Flaechen
  for (let i = 0; i < 40; i++) {
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grd.addColorStop(0, 'rgba(170,175,160,0.35)');
    grd.addColorStop(1, 'rgba(170,175,160,0)');
    g.save();
    g.translate(r(0, 512), r(0, 512));
    g.scale(r(30, 90), r(20, 50));
    g.fillStyle = grd;
    g.fillRect(-1, -1, 2, 2);
    g.restore();
  }
  // Rost: Flecken mit dunklem Kern, orange Rand
  for (let i = 0; i < 130; i++) {
    const x = r(0, 512), y = r(0, 512), rad = r(3, 18);
    for (let k = 0; k < 18; k++) {
      g.fillStyle = k < 6 ? `rgba(${r(115, 145)},${r(62, 80)},${r(32, 42)},0.3)` : `rgba(${r(62, 85)},${r(36, 46)},${r(22, 30)},0.45)`;
      g.beginPath();
      g.arc(x + r(-rad, rad) * 0.6, y + r(-rad, rad) * 0.6, rad * r(0.2, 0.6) * (k < 6 ? 1.3 : 0.8), 0, Math.PI * 2);
      g.fill();
    }
    // Laufspur nach unten (Textur-v nach oben = Fahrzeug oben)
    g.strokeStyle = `rgba(${r(90, 130)},${r(45, 60)},${r(25, 35)},0.25)`;
    g.lineWidth = r(2, 6);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + r(-3, 3), y + r(20, 70));
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
