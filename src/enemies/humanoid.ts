import * as THREE from 'three';
import { camoTexture } from '../world/textures';

export type PoseName = 'stand' | 'aim' | 'prone' | 'proneAim' | 'binoculars' | 'crouch' | 'lowReady';

type JointKey = 'hips' | 'spine' | 'head' | 'uArmL' | 'fArmL' | 'uArmR' | 'fArmR' | 'thighL' | 'shinL' | 'thighR' | 'shinR';
type Pose = {
  bodyY: number; // Hoehe der Huefte
  prone: number; // 0..1
  joints: Partial<Record<JointKey, [number, number, number]>>;
  rifle: { pos: [number, number, number]; rot: [number, number, number] };
  binos: boolean;
};

const POSES: Record<PoseName, Pose> = {
  stand: {
    bodyY: 0.95, prone: 0,
    joints: { uArmR: [-0.5, 0, -0.15], fArmR: [-1.1, 0, 0], uArmL: [-0.7, 0, 0.35], fArmL: [-1.0, 0, 0] },
    rifle: { pos: [0.02, 0.18, 0.26], rot: [0.9, 0.5, 0.1] }, binos: false,
  },
  lowReady: {
    bodyY: 0.95, prone: 0,
    joints: { spine: [0.05, 0, 0], uArmR: [-0.6, 0, -0.1], fArmR: [-1.0, 0, 0], uArmL: [-0.9, 0, 0.3], fArmL: [-0.7, 0, 0] },
    rifle: { pos: [0.05, 0.25, 0.3], rot: [0.55, 0.15, 0] }, binos: false,
  },
  aim: {
    bodyY: 0.95, prone: 0,
    joints: { spine: [0.05, -0.15, 0], head: [0.1, 0.12, 0], uArmR: [-1.35, 0, -0.45], fArmR: [-0.6, 0, 0.3], uArmL: [-1.45, 0, 0.35], fArmL: [-0.15, 0, 0] },
    rifle: { pos: [0.1, 0.44, 0.32], rot: [0, 0.12, 0] }, binos: false,
  },
  crouch: {
    bodyY: 0.62, prone: 0,
    joints: { spine: [0.35, 0, 0], head: [-0.25, 0, 0], thighL: [-1.4, 0, 0.1], shinL: [1.9, 0, 0], thighR: [-0.4, 0, -0.1], shinR: [1.9, 0, 0], uArmR: [-0.8, 0, -0.1], fArmR: [-1.0, 0, 0], uArmL: [-1.0, 0, 0.3], fArmL: [-0.8, 0, 0] },
    rifle: { pos: [0.05, 0.25, 0.3], rot: [0.5, 0.1, 0] }, binos: false,
  },
  prone: {
    bodyY: 0.18, prone: 1,
    joints: { head: [-1.1, 0, 0], uArmR: [-2.6, 0, -0.4], fArmR: [-0.9, 0, 0], uArmL: [-2.7, 0, 0.4], fArmL: [-0.6, 0, 0], thighL: [0, 0, 0.12], thighR: [0, 0, -0.12] },
    rifle: { pos: [0.08, 0.6, -0.12], rot: [-1.45, 0.2, 0] }, binos: false,
  },
  proneAim: {
    bodyY: 0.2, prone: 1,
    joints: { spine: [-0.08, 0, 0], head: [-1.2, 0.05, 0], uArmR: [-2.75, 0, -0.35], fArmR: [-0.5, 0, 0.2], uArmL: [-2.9, 0, 0.45], fArmL: [-0.2, 0, 0], thighL: [0, 0, 0.15], thighR: [0, 0, -0.2] },
    rifle: { pos: [0.1, 0.62, -0.18], rot: [-1.52, 0.05, 0] }, binos: false,
  },
  binoculars: {
    bodyY: 0.95, prone: 0,
    joints: { head: [0.05, 0, 0], uArmR: [-1.25, 0, -0.5], fArmR: [-1.6, 0, 0.6], uArmL: [-1.25, 0, 0.5], fArmL: [-1.6, 0, -0.6] },
    rifle: { pos: [0.18, 0.2, -0.16], rot: [0.3, 0, 0.35] }, binos: true,
  },
};

const mats = (() => {
  const camo = camoTexture();
  camo.repeat.set(2, 2);
  return {
    uniform: new THREE.MeshStandardMaterial({ map: camo, roughness: 0.95 }),
    vest: new THREE.MeshStandardMaterial({ color: 0x4d4a38, roughness: 0.9 }),
    helmet: new THREE.MeshStandardMaterial({ map: camo, color: 0x9a9480, roughness: 0.8 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x9c7458, roughness: 0.7 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1d1c19, roughness: 0.8 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x24231f, roughness: 0.5, metalness: 0.5 }),
    tan: new THREE.MeshStandardMaterial({ color: 0x5f5644, roughness: 0.7, metalness: 0.2 }),
    lens: new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.05, metalness: 0.9 }),
  };
})();

function capsule(r: number, len: number, mat: THREE.Material, yOffset = -len / 2) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
  m.position.y = yOffset;
  m.castShadow = true;
  return m;
}

function buildRifle(): { group: THREE.Group; scopeFront: THREE.Object3D } {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.06, 0.1, 0.62), mats.tan, 0, -0.02, 0.05); // Schaft/Gehaeuse
  add(new THREE.BoxGeometry(0.05, 0.14, 0.28), mats.tan, 0, -0.04, -0.33); // Kolben
  add(new THREE.CylinderGeometry(0.012, 0.014, 0.62, 8), mats.gun, 0, 0.02, 0.62, Math.PI / 2); // Lauf
  add(new THREE.CylinderGeometry(0.022, 0.022, 0.3, 10), mats.gun, 0, 0.085, 0.08, Math.PI / 2); // Zielfernrohr
  add(new THREE.CylinderGeometry(0.028, 0.022, 0.06, 10), mats.gun, 0, 0.085, 0.25, Math.PI / 2);
  add(new THREE.BoxGeometry(0.03, 0.08, 0.04), mats.gun, 0, -0.08, 0.02); // Griff
  const front = new THREE.Object3D();
  front.position.set(0, 0.085, 0.29);
  g.add(front);
  return { group: g, scopeFront: front };
}

export class Humanoid {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly j: Record<JointKey, THREE.Object3D>;
  readonly rifle: THREE.Group;
  readonly scopeFront: THREE.Object3D;
  readonly binos: THREE.Group;
  readonly binoFront: THREE.Object3D;
  readonly headMesh: THREE.Mesh;
  private chestTop = new THREE.Object3D();
  private cur: Pose;
  private target: PoseName = 'stand';
  walkPhase = 0;
  walkAmount = 0;
  deathT = -1;
  private deathDir = 1;

  constructor() {
    this.root.add(this.body);
    const hips = new THREE.Group();
    hips.position.y = 0.95;
    this.body.add(hips);
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.2), mats.uniform);
    pelvis.castShadow = true;
    hips.add(pelvis);

    const spine = new THREE.Group();
    spine.position.y = 0.06;
    hips.add(spine);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.32, 4, 10), mats.uniform);
    torso.scale.set(1.2, 1, 0.8);
    torso.position.y = 0.28;
    torso.castShadow = true;
    spine.add(torso);
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.27), mats.vest);
    vest.position.y = 0.32;
    vest.castShadow = true;
    spine.add(vest);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.12), mats.vest);
    pack.position.set(0, 0.3, -0.19);
    spine.add(pack);
    this.chestTop.position.y = 0.55;
    spine.add(this.chestTop);

    const head = new THREE.Group();
    head.position.y = 0.62;
    spine.add(head);
    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 12), mats.skin);
    this.headMesh.position.y = 0.1;
    this.headMesh.scale.set(0.9, 1.1, 1);
    this.headMesh.castShadow = true;
    head.add(this.headMesh);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.128, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mats.helmet);
    helmet.position.set(0, 0.13, -0.01);
    helmet.castShadow = true;
    head.add(helmet);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8), mats.skin);
    neck.position.y = 0.0;
    head.add(neck);

    const arm = (side: 1 | -1) => {
      const sh = new THREE.Group();
      sh.position.set(side * 0.22, 0.48, 0);
      spine.add(sh);
      sh.add(capsule(0.055, 0.22, mats.uniform, -0.14));
      const el = new THREE.Group();
      el.position.y = -0.29;
      sh.add(el);
      el.add(capsule(0.045, 0.2, mats.uniform, -0.12));
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), mats.dark);
      hand.position.y = -0.27;
      el.add(hand);
      return [sh, el] as const;
    };
    const [uArmL, fArmL] = arm(-1);
    const [uArmR, fArmR] = arm(1);

    const leg = (side: 1 | -1) => {
      const th = new THREE.Group();
      th.position.set(side * 0.1, -0.05, 0);
      hips.add(th);
      th.add(capsule(0.075, 0.3, mats.uniform, -0.2));
      const kn = new THREE.Group();
      kn.position.y = -0.43;
      th.add(kn);
      kn.add(capsule(0.06, 0.3, mats.uniform, -0.2));
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.1, 0.26), mats.dark);
      boot.position.set(0, -0.43, 0.05);
      boot.castShadow = true;
      kn.add(boot);
      return [th, kn] as const;
    };
    const [thighL, shinL] = leg(-1);
    const [thighR, shinR] = leg(1);

    this.j = { hips, spine, head, uArmL, fArmL, uArmR, fArmR, thighL, shinL, thighR, shinR };

    const r = buildRifle();
    this.rifle = r.group;
    this.scopeFront = r.scopeFront;
    spine.add(this.rifle);

    this.binos = new THREE.Group();
    for (const x of [-0.035, 0.035]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.028, 0.13, 10), mats.gun);
      b.rotation.x = Math.PI / 2;
      b.position.x = x;
      this.binos.add(b);
    }
    this.binos.position.set(0, 0.11, 0.17);
    head.add(this.binos);
    this.binoFront = new THREE.Object3D();
    this.binoFront.position.set(0, 0, 0.07);
    this.binos.add(this.binoFront);

    this.cur = structuredClonePose(POSES.stand);
    this.applyPose(this.cur);
  }

  setPose(p: PoseName) {
    this.target = p;
  }

  get pose(): PoseName {
    return this.target;
  }

  die(fromDir: THREE.Vector3) {
    if (this.deathT >= 0) return;
    this.deathT = 0;
    const local = fromDir.clone().applyQuaternion(this.root.quaternion.clone().invert());
    this.deathDir = local.z > 0 ? 1 : -1;
  }

  update(dt: number) {
    const tgt = POSES[this.target];
    const k = 1 - Math.exp(-7 * dt);
    const c = this.cur;
    c.bodyY += (tgt.bodyY - c.bodyY) * k;
    c.prone += (tgt.prone - c.prone) * k;
    for (const key of Object.keys(this.j) as JointKey[]) {
      const a = c.joints[key] ?? [0, 0, 0];
      const b = tgt.joints[key] ?? [0, 0, 0];
      c.joints[key] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
    for (let i = 0; i < 3; i++) {
      c.rifle.pos[i] += (tgt.rifle.pos[i] - c.rifle.pos[i]) * k;
      c.rifle.rot[i] += (tgt.rifle.rot[i] - c.rifle.rot[i]) * k;
    }
    c.binos = tgt.binos;
    this.applyPose(c);

    // Gehbewegung ueberlagern
    if (this.walkAmount > 0.01 && c.prone < 0.5) {
      const s = Math.sin(this.walkPhase), w = this.walkAmount;
      this.j.thighL.rotation.x += s * 0.55 * w;
      this.j.thighR.rotation.x -= s * 0.55 * w;
      this.j.shinL.rotation.x += Math.max(0, -Math.cos(this.walkPhase)) * 0.9 * w;
      this.j.shinR.rotation.x += Math.max(0, Math.cos(this.walkPhase)) * 0.9 * w;
      this.j.hips.position.y += Math.abs(Math.cos(this.walkPhase)) * 0.04 * w;
      this.j.spine.rotation.y += s * 0.08 * w;
    }

    if (this.deathT >= 0) {
      this.deathT += dt;
      const t = Math.min(1, this.deathT / 0.75);
      const e = t * t;
      if (c.prone > 0.5) {
        this.j.head.rotation.x = -0.2;
        this.j.uArmL.rotation.x = -1.8;
        this.j.uArmR.rotation.x = -1.6;
      } else {
        this.body.rotation.x = this.deathDir * (Math.PI / 2 - 0.08) * e;
        this.body.position.y = 0.0;
        this.j.hips.position.y = c.bodyY * (1 - e) + 0.16 * e;
        this.j.thighL.rotation.x = -0.3 * e;
        this.j.uArmL.rotation.x = -2 * e;
        this.j.uArmR.rotation.x = -1.4 * e;
        this.rifle.position.y -= 0.2 * e;
      }
    }
  }

  private applyPose(c: Pose) {
    for (const key of Object.keys(this.j) as JointKey[]) {
      const r = c.joints[key] ?? [0, 0, 0];
      this.j[key].rotation.set(r[0], r[1], r[2]);
    }
    this.j.hips.position.y = c.bodyY > 0.5 ? c.bodyY : 0.95;
    // Liegen: ganzen Koerper nach vorne kippen (Kopf in Blickrichtung)
    this.body.rotation.x = (Math.PI / 2) * c.prone;
    this.body.position.set(0, c.prone * (c.bodyY + 0.0) - c.prone * 0.0, -0.95 * c.prone);
    if (c.prone > 0.01) this.body.position.y = 0.18 * c.prone + (1 - c.prone) * 0;
    this.rifle.position.set(c.rifle.pos[0], c.rifle.pos[1], c.rifle.pos[2]);
    this.rifle.rotation.set(c.rifle.rot[0], c.rifle.rot[1], c.rifle.rot[2]);
    this.binos.visible = c.binos;
  }

  /** Trefferzonen in Weltkoordinaten. */
  hitzones(out: { head: THREE.Vector3; torsoA: THREE.Vector3; torsoB: THREE.Vector3; legA: THREE.Vector3; legB: THREE.Vector3 }) {
    this.headMesh.getWorldPosition(out.head);
    this.j.hips.getWorldPosition(out.torsoA);
    this.chestTop.getWorldPosition(out.torsoB);
    this.j.hips.getWorldPosition(out.legA);
    this.j.shinL.getWorldPosition(out.legB);
    out.legB.lerp(new THREE.Vector3().setFromMatrixPosition(this.j.shinR.matrixWorld), 0.5);
    return out;
  }
}

function structuredClonePose(p: Pose): Pose {
  return {
    bodyY: p.bodyY, prone: p.prone, binos: p.binos,
    joints: Object.fromEntries(Object.entries(p.joints).map(([k, v]) => [k, [...v!]])) as Pose['joints'],
    rifle: { pos: [...p.rifle.pos], rot: [...p.rifle.rot] },
  };
}
