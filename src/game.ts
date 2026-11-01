import * as THREE from 'three';
import { BloomEffect, BrightnessContrastEffect, EffectComposer, EffectPass, HueSaturationEffect, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { DIFFICULTIES, Difficulty, DifficultyId, RIFLE, jevEnabled, settings } from './config';
import { Rng, clamp } from './core/rng';
import { Terrain } from './world/terrain';
import { atmoUniforms } from './world/atmosphere';
import { GroundLight } from './world/groundlight';
import { SkySystem } from './world/sky';
import { Vegetation, windUniforms } from './world/vegetation';
import { buildCover, CoverDef, CoverKind } from './world/cover';
import { flagTexture, sandbagTexture } from './world/textures';
import { Player } from './player';
import { Bullet, SegmentHit } from './ballistics';
import { Enemy, EnemyEnv, EnemyType, HitZone } from './enemies/enemy';
import { Director, Situation } from './ai/director';
import { Fx } from './fx';
import { Hud } from './hud';
import { audio } from './audio';

type ImpactKind = 'erde' | 'stein' | 'holz' | 'metall' | 'blaetter' | 'koerper';

interface PropBox {
  inv: THREE.Matrix4;
  box: THREE.Box3;
  kind: ImpactKind;
}

interface HitData {
  kind: 'terrain' | 'prop' | 'enemy';
  enemy?: Enemy;
  zone?: HitZone;
  impact: ImpactKind;
  normal: THREE.Vector3;
}

interface Pending {
  t: number;
  fn: () => void;
}

interface Flag {
  mesh: THREE.Mesh;
  base: Float32Array;
}

export interface RoundStats {
  won: boolean;
  reason: string;
  kills: number;
  enemies: number;
  shots: number;
  hits: number;
  longest: number;
  time: number;
  difficulty: string;
}

const UP = new THREE.Vector3(0, 1, 0);

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private effectPass: EffectPass;
  private scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(RIFLE.baseFov, 1, 0.1, 9000);
  private bulletCamera = new THREE.PerspectiveCamera(40, 1, 0.05, 9000);
  readonly hud = new Hud();
  private fx!: Fx;
  private rng!: Rng;
  private terrain!: Terrain;
  private sky!: SkySystem;
  player!: Player;
  private cover!: CoverDef;
  enemies: Enemy[] = [];
  private director!: Director;
  private diff: Difficulty = DIFFICULTIES.normal;
  private props: PropBox[] = [];
  private flags: Flag[] = [];
  private fires: THREE.Vector3[] = [];
  private bullets: { b: Bullet<HitData>; cam: boolean; tracePts: boolean }[] = [];
  private pending: Pending[] = [];
  private wind = new THREE.Vector3();
  private windBase = 0;
  private windDir = 0;
  private gust = 0;
  private time = 0;
  private timeScale = 1;
  private smokeT = 0;
  private dustT = 0;
  private lastShotTime = -99;
  private hits = 0;
  private kills = 0;
  private longest = 0;
  private bulletCam: { bullet: Bullet<HitData>; after: number; mesh: THREE.Mesh; target: Enemy } | null = null;
  private seed = 0;
  running = false;
  paused = false;
  onEnd: (s: RoundStats) => void = () => {};
  private endScheduled = false;
  private lookPoint = new THREE.Vector3();
  hp = 1;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false, depth: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    const bloom = new BloomEffect({ intensity: 1.1, luminanceThreshold: 0.92, luminanceSmoothing: 0.05, mipmapBlur: true, radius: 0.7 });
    // Khronos PBR Neutral: haelt Farbton und Saettigung besser als ACES
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
    const grade = [new BrightnessContrastEffect({ contrast: 0.07 }), new HueSaturationEffect({ saturation: 0.06 })];
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.45 });
    this.effectPass = new EffectPass(this.camera, bloom, tone, ...grade, new SMAAEffect(), vignette);
    this.composer.addPass(this.effectPass);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    for (const c of [this.camera, this.bulletCamera]) {
      c.aspect = w / h;
      c.updateProjectionMatrix();
    }
    this.hud.resize();
  }

  private disposeScene() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.scene.environment?.dispose();
    if (atmoUniforms.atmoGround.value instanceof THREE.DataTexture && atmoUniforms.atmoGround.value.image.width > 1) {
      atmoUniforms.atmoGround.value.dispose();
    }
    atmoUniforms.atmoGroundRect.value.set(0, 0, 0, 0);
    this.scene = new THREE.Scene();
    this.renderPass.mainScene = this.scene;
  }

  applyQuality() {
    const q = settings.quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.resize();
  }

  start(diffId: DifficultyId, seed = Math.floor(Math.random() * 1e9)) {
    this.disposeScene();
    this.applyQuality();
    this.seed = seed;
    this.diff = DIFFICULTIES[diffId];
    const rng = (this.rng = new Rng(seed));
    this.fx = new Fx(this.scene);
    this.props = [];
    this.flags = [];
    this.fires = [];
    this.bullets = [];
    this.pending = [];
    this.enemies = [];
    this.bulletCam = null;
    this.time = 0;
    this.timeScale = 1;
    this.hits = this.kills = this.longest = 0;
    this.hp = this.diff.lives;
    this.hud.threats = [];
    this.lastShotTime = -99;
    this.endScheduled = false;

    this.terrain = new Terrain(rng);
    this.scene.add(this.terrain.mesh);
    this.sky = new SkySystem(this.scene, this.renderer, rng);

    // Wind
    this.windBase = rng.range(0.4, this.diff.maxWind);
    this.windDir = rng.range(0, Math.PI * 2);

    // Deckung auf dem Grat
    const kind = rng.pick<CoverKind>(['busch', 'fels', 'huette', 'holzstapel', 'autowrack']);
    this.cover = buildCover(kind, rng);
    // Standort mit der besten Sicht ins Tal waehlen
    let px = 0, pz = 0, bestScore = -1;
    for (let i = 0; i < 70; i++) {
      const x = rng.range(-150, 150), z = rng.range(-25, 8);
      if (this.terrain.slopeAt(x, z) > 0.2) continue;
      const eye = new THREE.Vector3(x, this.terrain.heightAt(x, z) + 1.4, z);
      let score = 0;
      for (let k = 0; k < 14; k++) {
        const d = this.diff.distance[0] + ((this.diff.distance[1] - this.diff.distance[0]) * (k % 7)) / 6;
        const a = (k < 7 ? -0.25 : 0.25) + ((k % 3) - 1) * 0.12;
        const tx = x + Math.sin(a) * d, tz = z - Math.cos(a) * d;
        const tgt = new THREE.Vector3(tx, this.terrain.heightAt(tx, tz) + 1.3, tz);
        if (this.terrain.lineOfSight(eye, tgt, 0.4)) score++;
      }
      score -= this.terrain.slopeAt(x, z) * 5;
      if (score > bestScore) { bestScore = score; px = x; pz = z; }
    }
    const facing = 0; // Deckung blickt lokal nach -Z, Gegner liegen bei -Z
    let groundY = this.terrain.heightAt(px, pz);
    if (kind === 'huette') {
      for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) groundY = Math.max(groundY, this.terrain.heightAt(px + dx, pz + dz));
    }
    this.cover.group.position.set(px, groundY, pz);
    this.cover.group.rotation.y = facing + rng.range(-0.2, 0.2);
    this.scene.add(this.cover.group);
    this.cover.group.updateMatrixWorld(true);
    const aimEye = this.cover.aimEye.clone().applyMatrix4(this.cover.group.matrixWorld);

    // Gegner platzieren
    const count = rng.int(this.diff.enemyCount[0], this.diff.enemyCount[1]);
    const types: EnemyType[] = [];
    if (this.diff.id !== 'leicht' || count >= 3) types.push('scharfschuetze');
    if (count >= 3) types.push('spotter');
    while (types.length < count) types.push(rng.pick<EnemyType>(['wache', 'patrouille', 'wache']));
    const placed: THREE.Vector3[] = [];
    types.forEach((type, id) => {
      let pos: THREE.Vector3 | null = null;
      for (let tries = 0; tries < 900 && !pos; tries++) {
        const relax = tries > 450 ? 1 : 0;
        const d = rng.range(this.diff.distance[0] * (relax ? 0.85 : 1), this.diff.distance[1] * (relax ? 1.15 : 1));
        const a = rng.range(-0.42 - relax * 0.25, 0.42 + relax * 0.25);
        const x = aimEye.x + Math.sin(a) * d, z = aimEye.z - Math.cos(a) * d;
        const y = this.terrain.heightAt(x, z);
        if (this.terrain.slopeAt(x, z) > 0.32 + relax * 0.1) continue;
        if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < (relax ? 16 : 28))) continue;
        const chest = new THREE.Vector3(x, y + (type === 'scharfschuetze' ? 0.35 : 1.3), z);
        if (!this.terrain.lineOfSight(aimEye, chest, relax ? 0.15 : 0.4)) continue;
        if (Math.abs(y - aimEye.y) / d > (relax ? 0.42 : 0.34)) continue;
        pos = new THREE.Vector3(x, y, z);
      }
      if (!pos) return;
      placed.push(pos);
      const e = new Enemy(id, type, pos, aimEye, this.fx.glowTex, rng);
      this.enemies.push(e);
      this.scene.add(e.human.root, e.glintSprite);
      e.human.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true) : null));
      if (type === 'wache') this.addGuardPost(e, aimEye);
      if (type === 'patrouille') {
        const side = new THREE.Vector3(Math.cos(e.yaw), 0, -Math.sin(e.yaw));
        const wps = [-1, 1, 0.3].map((s) => {
          const p = pos!.clone().addScaledVector(side, s * rng.range(18, 32));
          p.y = this.terrain.heightAt(p.x, p.z);
          return p;
        });
        e.setWaypoints(wps);
      }
    });
    // Feste Ids nach Platzierung neu vergeben (falls einer nicht platzierbar war)
    this.enemies.forEach((e, i) => ((e as { id: number }).id = i));

    const center = this.enemies.reduce((a, e) => a.add(e.pos), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, this.enemies.length));
    center.y += 1;

    // Windfahnen: eine am Gegnerhang, eine im Tal
    this.addFlag(center.clone().add(new THREE.Vector3(rng.range(-30, 30), 0, rng.range(-15, 15))));
    const mid = aimEye.clone().lerp(center, 0.45).add(new THREE.Vector3(rng.range(-40, 40), 0, 0));
    this.addFlag(mid);

    // Vegetation mit freien Sichtschneisen
    const lanes = this.enemies.map((e) => [aimEye.clone(), e.pos.clone()] as const);
    const distToLane = (x: number, z: number) => {
      let best = Infinity;
      for (const [a, b] of lanes) {
        const abx = b.x - a.x, abz = b.z - a.z;
        const t = clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
        best = Math.min(best, Math.hypot(a.x + abx * t - x, a.z + abz * t - z));
      }
      return best;
    };
    const exclude = (x: number, z: number) => {
      if (Math.hypot(x - px, z - pz) < 7) return true;
      if (this.enemies.some((e) => Math.hypot(e.pos.x - x, e.pos.z - z) < 5)) return true;
      if (this.props.some(() => false)) return true;
      return distToLane(x, z) < 8;
    };
    const grassExclude = (x: number, z: number) => {
      if (Math.hypot(x - px, z - pz) < (kind === 'huette' ? 2.6 : 2)) return true;
      return this.enemies.some((e) => Math.hypot(e.pos.x - x, e.pos.z - z) < 3.2);
    };
    const ground = new GroundLight(this.terrain, this.sky.atmo.sunDir);
    const veg = new Vegetation(this.terrain, rng, exclude, grassExclude, this.enemies.map((e) => e.pos), aimEye, ground);
    this.scene.add(veg.group);
    atmoUniforms.atmoGround.value = ground.finish();
    atmoUniforms.atmoGroundRect.value.copy(GroundLight.rect());
    this.sky.setFogBase(aimEye.y);

    // Spieler
    this.player = new Player(this.camera, this.terrain, this.cover, center, rng.range(-1, 1));
    this.director = new Director(rng);
    this.running = true;
    this.paused = false;
    this.hud.toast(`${this.cover.label}: ${this.cover.hint}`, 5);
    if (this.diff.tagging === 'auto') this.enemies.forEach((e) => (e.tagged = true));
    this.hud.brief(this.briefing(aimEye));
    audio.ambience(this.sky.atmo.weather);
    this.updateWind(0);
  }

  /** Funk-Einweisung: Richtung als Uhrzeit, Entfernung grob, Merkmal. */
  private briefing(eye: THREE.Vector3): string {
    const by = this.player.baseYaw;
    const f = new THREE.Vector3(-Math.sin(by), 0, -Math.cos(by));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const lines = this.enemies.map((e) => {
      const d = e.pos.clone().sub(eye).setY(0);
      const ang = THREE.MathUtils.radToDeg(Math.atan2(d.dot(r), d.dot(f)));
      const side = Math.abs(ang) < 4 ? 'geradeaus' : `${Math.round(Math.abs(ang))}° ${ang < 0 ? 'links' : 'rechts'}`;
      const dist = Math.round(e.pos.distanceTo(eye) / 50) * 50;
      const note = { wache: 'am Lagerfeuer hinter Sandsaecken', patrouille: 'laeuft am Hang hin und her', scharfschuetze: 'liegt im Gras, sehr schwer zu sehen', spotter: 'mit Fernglas, stehend' }[e.type];
      return `<b>${e.info.label}</b> · ${side} · ca. ${dist} m · ${note}`;
    });
    return `Funk: ${this.enemies.length} Ziele am Gegenhang. Rote Fahnen markieren die Stellung. Richtung ab Rundenstart-Blick.<br>${lines.join('<br>')}`;
  }

  private addGuardPost(e: Enemy, playerEye: THREE.Vector3) {
    const tex = sandbagTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    const geo = new THREE.CapsuleGeometry(0.17, 0.38, 3, 8);
    geo.rotateZ(Math.PI / 2);
    const toP = new THREE.Vector3(playerEye.x - e.pos.x, 0, playerEye.z - e.pos.z).normalize();
    const yaw = Math.atan2(toP.x, toP.z);
    const g = new THREE.Group();
    for (let layer = 0; layer < 3; layer++) {
      for (let i = -3; i <= 3; i++) {
        const a = i * 0.2 + (layer % 2) * 0.1;
        const m = new THREE.Mesh(geo, mat);
        m.position.set(Math.sin(a) * 1.3, 0.15 + layer * 0.27, Math.cos(a) * 1.3);
        m.rotation.y = a + Math.PI / 2;
        m.scale.set(1, 0.85, 1.2);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
    }
    g.position.copy(e.pos);
    g.position.y = this.terrain.heightAt(e.pos.x, e.pos.z) - 0.05;
    g.rotation.y = yaw;
    this.scene.add(g);
    g.updateMatrixWorld(true);
    // Kugelfang (vereinfachte Box)
    const box = new THREE.Box3(new THREE.Vector3(-1.35, -0.2, 0.95), new THREE.Vector3(1.35, 0.85, 1.55));
    this.props.push({ inv: g.matrixWorld.clone().invert(), box, kind: 'erde' });
    // Lagerfeuer daneben: Rauch zeigt den Wind
    const fire = e.pos.clone().add(new THREE.Vector3(Math.cos(yaw) * 2.5, 0, -Math.sin(yaw) * 2.5));
    fire.y = this.terrain.heightAt(fire.x, fire.z) + 0.2;
    this.fires.push(fire);
    const stones = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.08, 6, 10), new THREE.MeshStandardMaterial({ color: 0x555049 }));
    stones.rotation.x = Math.PI / 2;
    stones.position.copy(fire).setY(fire.y - 0.15);
    this.scene.add(stones);
    const ember = new THREE.PointLight(0xff7a30, 2, 4);
    ember.position.copy(fire);
    this.scene.add(ember);
  }

  private addFlag(at: THREE.Vector3) {
    at.y = this.terrain.heightAt(at.x, at.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 6, 6), new THREE.MeshStandardMaterial({ color: 0x777066, metalness: 0.6, roughness: 0.5 }));
    pole.position.copy(at).setY(at.y + 3);
    pole.castShadow = true;
    this.scene.add(pole);
    const geo = new THREE.PlaneGeometry(1.6, 0.9, 16, 6);
    geo.translate(0.8, 0, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: flagTexture(), side: THREE.DoubleSide, roughness: 0.9 }));
    mesh.position.copy(at).setY(at.y + 5.5);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.flags.push({ mesh, base: Float32Array.from(geo.attributes.position.array as Float32Array) });
  }

  // ---------------------------------------------------------------- Eingabe

  fire() {
    const p = this.player;
    if (!this.running || this.paused || this.bulletCam) return;
    if (!p.canFire) {
      if (p.state === 'up' && p.ammo === 0) audio.dryClick();
      return;
    }
    const { origin, dir } = p.shotRay();
    audio.playerShot();
    this.fx.muzzleFlash(origin, dir, 0.6);
    p.onFired();
    this.lastShotTime = this.time;
    const b = new Bullet<HitData>(origin, dir);
    // Alle hoeren den Schuss (Schall braucht Zeit)
    for (const e of this.enemies) {
      const d = e.pos.distanceTo(origin);
      this.later(d / 343, () => e.hearShot(d, this.cover.camo * (this.cover.kind === 'huette' ? 0.7 : 1), this.time));
    }
    // Bullet-Cam: wird der letzte Gegner getroffen?
    const alive = this.enemies.filter((e) => !e.dead);
    let cam = false;
    if (alive.length === 1) {
      const probe = new Bullet<HitData>(origin, dir);
      let res: SegmentHit<HitData> | null = null;
      for (let i = 0; i < 400 && probe.alive && !res; i++) res = probe.advance(0.01, this.wind, (a, c) => this.collide(a, c));
      if (res && res.data.kind === 'enemy' && res.data.enemy === alive[0] && (res.data.zone !== 'bein' || alive[0].wounds > 0)) cam = true;
    }
    this.bullets.push({ b, cam, tracePts: this.diff.showTrace });
    if (cam) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.0039, 0.0039, 0.031, 12), new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 0.9, roughness: 0.25 }));
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0039, 0.012, 12), mesh.material);
      tip.position.y = 0.0215;
      mesh.add(tip);
      this.scene.add(mesh);
      this.bulletCam = { bullet: b, after: 0, mesh, target: alive[0] };
      this.timeScale = 0.1;
    }
  }

  /** Gegner unter dem Fadenkreuz markieren. */
  tag() {
    if (!this.running || this.paused || !this.player) return;
    const p = this.player;
    if (this.diff.tagging === 'none') {
      this.hud.toast('Auf Elite gibt es keine Markierungen');
      return;
    }
    if (p.state !== 'up') return;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    let best: Enemy | null = null, bestAng = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const to = e.pos.clone().setY(e.pos.y + (e.human.pose === 'prone' || e.human.pose === 'proneAim' ? 0.3 : 1.1)).sub(this.camera.position);
      const dist = to.length();
      const ang = dir.angleTo(to);
      // Toleranz: ca. 2,5 m um den Gegner oder 0,6 Grad
      const tol = Math.max(2.5 / dist, 0.0105) * (p.scoped ? 1 : 2.5);
      if (ang < tol && ang < bestAng) { bestAng = ang; best = e; }
    }
    if (!best) {
      this.hud.toast('Kein Gegner im Fadenkreuz');
      return;
    }
    if (!best.tagged) {
      best.tagged = true;
      audio.zoomTick();
      const d = Math.round(best.pos.distanceTo(p.aimEye));
      this.hud.toast(this.diff.tagDistance ? `${best.info.label} markiert · ${d} m` : `${best.info.label} markiert`);
    }
  }

  skipCinematic() {
    if (this.bulletCam) this.timeScale = 1;
  }

  // ---------------------------------------------------------------- Simulation

  private later(t: number, fn: () => void) {
    this.pending.push({ t: this.time + t, fn });
  }

  private updateWind(dt: number) {
    const t = this.time;
    this.gust = (Math.sin(t * 0.37) + Math.sin(t * 0.91 + 1.3) * 0.6 + Math.sin(t * 2.3 + 0.4) * 0.25) / 1.85;
    const speed = Math.max(0, this.windBase * (1 + 0.38 * this.gust));
    const dir = this.windDir + Math.sin(t * 0.21) * 0.25;
    this.wind.set(Math.sin(dir) * speed, 0, Math.cos(dir) * speed);
    windUniforms.uWind.value.set(this.wind.x, this.wind.z);
    windUniforms.uTime.value += dt;
    audio.setWind(speed, this.gust * 0.5 + 0.5);
  }

  private collide(a: THREE.Vector3, b: THREE.Vector3): SegmentHit<HitData> | null {
    // Gegner
    for (const e of this.enemies) {
      const h = e.hitTest(a, b);
      if (h) return { point: h.point, data: { kind: 'enemy', enemy: e, zone: h.zone, impact: 'koerper', normal: a.clone().sub(b).normalize() } };
    }
    // Sandsaecke u. a.
    const la = new THREE.Vector3(), lb = new THREE.Vector3(), ray = new THREE.Ray(), hit = new THREE.Vector3();
    for (const pr of this.props) {
      la.copy(a).applyMatrix4(pr.inv);
      lb.copy(b).applyMatrix4(pr.inv);
      ray.origin.copy(la);
      ray.direction.copy(lb).sub(la);
      const len = ray.direction.length();
      if (len < 1e-6) continue;
      ray.direction.multiplyScalar(1 / len);
      if (ray.intersectBox(pr.box, hit) && hit.distanceTo(la) <= len) {
        const world = hit.applyMatrix4(pr.inv.clone().invert());
        return { point: world, data: { kind: 'prop', impact: pr.kind, normal: a.clone().sub(b).normalize() } };
      }
    }
    // Terrain
    const hb = this.terrain.heightAt(b.x, b.z);
    if (b.y < hb) {
      let lo = a.clone(), hi = b.clone();
      for (let i = 0; i < 8; i++) {
        const m = lo.clone().add(hi).multiplyScalar(0.5);
        if (m.y < this.terrain.heightAt(m.x, m.z)) hi = m; else lo = m;
      }
      const n = this.terrain.normalAt(hi.x, hi.z);
      const slope = 1 - n.y;
      return { point: hi, data: { kind: 'terrain', impact: slope > 0.35 ? 'stein' : 'erde', normal: n } };
    }
    return null;
  }

  private onBulletHit(hit: SegmentHit<HitData>, bullet: Bullet<HitData>) {
    const d = hit.data;
    const camDist = hit.point.distanceTo(this.camera.position);
    this.fx.impact(hit.point, d.normal, d.impact, this.wind);
    audio.impact(d.impact, camDist, hit.point);
    // Knapp daneben? Gegner in der Naehe werden nervoes
    for (const e of this.enemies) {
      if (e.dead || e === d.enemy) continue;
      if (e.pos.distanceTo(hit.point) < 6) e.nearMiss(this.time);
    }
    if (d.kind === 'enemy' && d.enemy) {
      this.hits++;
      const dir = bullet.vel.clone().normalize();
      const died = d.enemy.takeHit(d.zone!, dir, this.time);
      if (died) {
        this.kills++;
        const dist = Math.round(bullet.origin.distanceTo(hit.point));
        this.longest = Math.max(this.longest, dist);
        this.hud.toast(`${d.enemy.info.label} ausgeschaltet · ${d.zone === 'kopf' ? 'Kopftreffer' : 'Treffer'} · ${dist} m`);
        for (const o of this.enemies) if (!o.dead) o.comradeDown(this.time);
        this.director.update(0, this.enemies, this.situation(), true);
        if (this.enemies.every((e) => e.dead)) this.finish(true, 'Alle Gegner ausgeschaltet');
      } else {
        this.hud.toast(`Bein getroffen · ${d.enemy.info.label} geht in Deckung`);
      }
    }
  }

  private enemyFires(e: Enemy) {
    const p = this.player;
    const muzzle = new THREE.Vector3();
    e.human.scopeFront.getWorldPosition(muzzle);
    const dirToPlayer = p.aimEye.clone().sub(muzzle).normalize();
    this.fx.muzzleFlash(muzzle, dirToPlayer, 1);
    const dist = muzzle.distanceTo(p.aimEye);
    audio.distantShot(dist, true, muzzle);
    const travel = dist / 720;
    const exposed = p.exposed;
    const D = this.diff;
    const distF = clamp(1.15 - dist / 1800, 0.5, 1);
    const hitP = D.enemyAccuracy * e.info.accuracy * distF * (1 - 0.2 * e.nerves) * (e.wounds > 0 ? 0.7 : 1);
    this.later(travel, () => {
      if (!this.running || p.state === 'dead' || p.state === 'won') return;
      const nowExposed = p.exposed;
      if (exposed && nowExposed && this.rng.next() < hitP) {
        if (this.hp > 1) this.playerWounded(e, dist, muzzle);
        else this.playerKilled(e, dist, false);
        return;
      }
      if (!nowExposed && this.rng.next() < this.cover.penetration * 0.7) {
        if (this.hp > 1) this.playerWounded(e, dist, muzzle);
        else this.playerKilled(e, dist, true);
        return;
      }
      // Daneben bzw. in die Deckung
      const toEnemy = muzzle.clone().sub(p.aimEye).normalize();
      if (!nowExposed) {
        const pt = p.aimEye.clone().addScaledVector(toEnemy, this.cover.kind === 'huette' ? 0.75 : 1.0);
        pt.y -= 0.35;
        this.fx.impact(pt, toEnemy, this.cover.impact === 'blaetter' ? 'blaetter' : this.cover.impact, this.wind);
        audio.impact(this.cover.impact === 'blaetter' ? 'blaetter' : this.cover.impact, 1.2);
      } else {
        const side = new THREE.Vector3().crossVectors(toEnemy, UP).normalize();
        const pt = p.aimEye.clone().addScaledVector(side, (this.rng.next() - 0.5) * 3).addScaledVector(toEnemy, -2 - this.rng.next() * 6);
        pt.y = this.terrain.heightAt(pt.x, pt.z);
        this.fx.impact(pt, UP, 'erde', this.wind);
        audio.whiz();
        audio.impact('erde', pt.distanceTo(p.aimEye), pt);
      }
      p.nearMiss();
    });
  }

  /** Treffer, aber nicht toedlich: Schuetze wird sichtbar, kurze Zeitlupe zum Zurueckschlagen. */
  private playerWounded(e: Enemy, dist: number, muzzle: THREE.Vector3) {
    const p = this.player;
    this.hp--;
    p.pulse = Math.min(185, p.pulse + 40);
    audio.impact('koerper', 0.4);
    audio.muffleFor(2.5, 500);
    audio.tinnitus(2.5, 0.04);
    document.body.classList.add('hurt');
    setTimeout(() => document.body.classList.remove('hurt'), 700);
    e.tagged = true;
    // Schuetze braucht laenger fuer den naechsten Schuss
    e.phase = 'bolt';
    e.phaseT = -2.5;
    this.hud.threats.push({ pos: muzzle.clone(), enemy: e, until: performance.now() + 6000 });
    const by = Math.atan2(-(muzzle.x - p.aimEye.x), -(muzzle.z - p.aimEye.z));
    let rel = THREE.MathUtils.radToDeg(by - p.yaw);
    rel = ((rel + 540) % 360) - 180;
    const side = Math.abs(rel) < 4 ? 'direkt vor dir' : `${Math.round(Math.abs(rel))}° ${rel > 0 ? 'links' : 'rechts'}`;
    this.hud.toast(`Getroffen! ${e.info.label} · ${side} · ${Math.round(dist)} m — schlag zurueck!`, 4);
    this.timeScale = 0.35;
    this.later(0.55, () => {
      if (this.player.state !== 'dead') this.timeScale = 1;
    });
  }

  private playerKilled(e: Enemy, dist: number, throughCover: boolean) {
    const p = this.player;
    p.setState('dead');
    audio.impact('koerper', 0.5);
    audio.muffle(true);
    audio.tinnitus(3, 0.05);
    this.timeScale = 0.35;
    document.body.classList.add('hit');
    const reason = throughCover
      ? `Durch die Deckung getroffen (${this.cover.label}) · ${e.info.label}, ${Math.round(dist)} m`
      : `Getroffen von ${e.info.label} aus ${Math.round(dist)} m`;
    this.finish(false, reason);
  }

  private finish(won: boolean, reason: string) {
    if (this.endScheduled) return;
    this.endScheduled = true;
    if (won && this.player.state !== 'dead') this.player.setState('won');
    const delay = won ? (this.bulletCam ? 2.2 : 1.6) : 1.0;
    this.later(delay, () => {
      this.running = false;
      document.body.classList.remove('hit');
      this.onEnd({
        won, reason, kills: this.kills, enemies: this.enemies.length, shots: this.player.shots, hits: this.hits,
        longest: this.longest, time: Math.round(this.time), difficulty: this.diff.label,
      });
    });
  }

  private situation(): Situation {
    return {
      time: this.time,
      coverLabel: this.cover.label,
      coverPenetrable: this.cover.penetration > 0.2,
      playerExposed: this.player.exposed,
      playerExposedFor: this.player.exposedFor,
      lastPlayerShotAgo: this.time - this.lastShotTime,
      playerShots: this.player.shots,
      windSpeed: this.wind.length(),
      weather: this.sky.atmo.weather,
    };
  }

  update(realDt: number) {
    if (!this.player) return;
    const dt = Math.min(realDt, 0.05) * (this.paused ? 0 : this.timeScale);
    if (this.running && !this.paused) this.time += dt;
    this.updateWind(dt);

    // geplante Ereignisse
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].t <= this.time) {
        const ev = this.pending[i];
        this.pending.splice(i, 1);
        ev.fn();
      }
    }

    const p = this.player;
    let danger = 0;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.phase === 'glint' || e.phase === 'window' || e.phase === 'hold') danger = Math.max(danger, e.glint * (e.phase === 'window' ? 1 : 0.7));
    }
    if (!p.exposed) danger *= 0.4;
    if (this.paused) return this.render();

    p.update(dt, danger);
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    audio.setListener(this.camera.position, fwd);

    const playerView = { eye: p.aimEye, exposed: p.exposed && p.state !== 'dead', camo: this.cover.camo, penetrable: this.cover.penetration > 0.2 };
    const env: EnemyEnv = {
      dt, time: this.time, player: playerView, difficulty: this.diff,
      lineOfSight: (a, b) => this.terrain.lineOfSight(a, b, 0.2),
      groundAt: (x, z) => this.terrain.heightAt(x, z),
      sunDir: this.sky.atmo.sunDir,
      overcast: this.sky.atmo.weather === 'regen' || this.sky.atmo.weather === 'nebel',
      onAimStart: (e) => {
        const d = e.pos.distanceTo(p.aimEye);
        if (d < 380) audio.bolt(clamp(0.5 * (1 - d / 380), 0.05, 0.25), d / 343, e.pos);
      },
      onFire: (e) => this.enemyFires(e),
      onAlarm: (e) => {
        for (const o of this.enemies) if (o !== e) this.later(1.5 + Math.random(), () => o.alarm());
        this.hud.toast(`${e.info.label} hat Alarm gegeben`);
      },
    };
    if (p.state !== 'intro') {
      for (const e of this.enemies) e.update(env);
      if (this.running && p.state !== 'dead' && p.state !== 'won') this.director.update(dt, this.enemies, this.situation());
    } else {
      for (const e of this.enemies) e.human.update(dt);
      for (const e of this.enemies) {
        e.human.root.position.copy(e.pos);
        e.human.root.rotation.y = e.yaw;
      }
    }

    // Kugeln
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const entry = this.bullets[i];
      const hit = entry.b.advance(dt, this.wind, (a, c) => this.collide(a, c));
      if (hit) this.onBulletHit(hit, entry.b);
      if (!entry.b.alive) {
        if (entry.tracePts) this.fx.trace(entry.b.trail);
        this.bullets.splice(i, 1);
      }
    }

    // Windindikatoren
    this.smokeT -= dt;
    if (this.smokeT <= 0) {
      this.smokeT = 0.22;
      for (const f of this.fires) this.fx.smoke(f, this.wind);
    }
    this.dustT -= dt;
    if (this.dustT <= 0 && this.wind.length() > 4) {
      this.dustT = 1.2 / (this.wind.length() / 4);
      const e = this.enemies[Math.floor(Math.random() * this.enemies.length)];
      if (e) {
        const pt = e.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 40, 0, (Math.random() - 0.5) * 40));
        pt.y = this.terrain.heightAt(pt.x, pt.z) + 0.3;
        this.fx.dustDrift(pt, this.wind);
      }
    }
    this.updateFlags();
    this.fx.update(dt);

    // Bullet-Cam
    if (this.bulletCam) {
      const bc = this.bulletCam;
      const b = bc.bullet;
      const v = b.vel.clone().normalize();
      bc.mesh.position.copy(b.pos);
      bc.mesh.quaternion.setFromUnitVectors(UP, v);
      bc.mesh.rotateY(this.time * 300);
      const side = new THREE.Vector3().crossVectors(v, UP).normalize();
      this.bulletCamera.position.copy(b.pos).addScaledVector(v, -0.35).addScaledVector(side, 0.08).addScaledVector(UP, 0.03);
      if (!b.alive) {
        bc.after += realDt;
        this.timeScale = Math.min(1, 0.25 + bc.after * 0.4);
        const t = new THREE.Vector3();
        bc.target.human.headMesh.getWorldPosition(t);
        this.bulletCamera.position.copy(t).addScaledVector(v, -4).addScaledVector(side, 1.6).addScaledVector(UP, 0.6);
        this.bulletCamera.lookAt(t);
        if (bc.after > 2.2) {
          this.scene.remove(bc.mesh);
          this.bulletCam = null;
          this.timeScale = 1;
        }
      } else {
        this.bulletCamera.lookAt(b.pos.clone().addScaledVector(v, 10));
      }
    }

    // Schatten dort scharf, wo hingeschaut wird
    if (p.scopeBlend > 0.5) {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.lookPoint.copy(this.camera.position);
      for (let s = 20; s < 1500; s += 10) {
        const q = this.camera.position.clone().addScaledVector(dir, s);
        if (q.y < this.terrain.heightAt(q.x, q.z)) {
          this.lookPoint.copy(q);
          break;
        }
      }
      this.sky.focusShadows(this.lookPoint, 45);
    } else {
      this.sky.focusShadows(this.camera.position, 70);
    }
    this.sky.update(dt, this.camera.position, this.wind);

    // HUD
    if (p.state === 'intro') this.hud.setHint('Lauf zur Deckung …');
    else if (p.state === 'ducked') this.hud.setHint(p.reloadT > 0 ? 'Nachladen …' : 'Rechte Maustaste: anlegen   ·   W: aufrichten ohne Zielfernrohr');
    else if (p.state === 'up' && !p.scoped) this.hud.setHint('Rechte Maustaste halten: Zielfernrohr   ·   Leertaste: abducken');
    else if (p.scoped) this.hud.setHint(`Shift: Luft anhalten   ·   Mausrad: Zoom   ·   R + Mausrad: Fleckschuss${this.diff.tagging === 'manual' ? '   ·   Q: markieren' : ''}   ·   Leertaste: abducken`);
    else this.hud.setHint('');
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    f.y = 0;
    f.normalize();
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const windRel = THREE.MathUtils.radToDeg(Math.atan2(this.wind.dot(r), this.wind.dot(f)));
    this.hud.update(realDt, danger, this.wind.length(), windRel, this.diff.showWindHud);
    this.hud.drawDebug(
      this.enemies,
      this.director.status,
      `Wind ${this.wind.length().toFixed(1)} m/s · Wetter ${this.sky.atmo.weather} · Deckung ${this.cover.label} · Seed ${this.seed} · Jev ${jevEnabled() ? 'konfiguriert' : 'nicht konfiguriert (.env.local)'} · I schliesst`,
    );
    this.render();
  }

  private updateFlags() {
    const w = this.wind;
    const speed = w.length();
    const yaw = Math.atan2(w.x, w.z) - Math.PI / 2;
    for (const f of this.flags) {
      f.mesh.rotation.y = yaw;
      const pos = f.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const droop = clamp(1 - speed / 6, 0, 1);
      for (let i = 0; i < pos.count; i++) {
        const x = f.base[i * 3], y = f.base[i * 3 + 1];
        const t = x / 1.6;
        const wave = Math.sin(x * 4 - windUniforms.uTime.value * (3 + speed)) * 0.12 * t * (0.3 + speed / 8);
        // bei wenig Wind haengt die Fahne herunter
        const nx = x * (1 - droop * 0.85);
        const ny = y - x * droop * 0.95;
        pos.setXYZ(i, nx, ny, wave);
      }
      pos.needsUpdate = true;
      f.mesh.geometry.computeVertexNormals();
    }
  }

  private render() {
    const p = this.player;
    const cam = this.bulletCam ? this.bulletCamera : this.camera;
    this.renderPass.mainCamera = cam;
    this.effectPass.mainCamera = cam;
    if (p) {
      this.hud.drawScope(p, !!this.bulletCam);
      if (!this.bulletCam) {
        this.hud.drawMarkers(this.enemies, this.camera, p.aimEye, this.diff.tagDistance, p.scopeBlend);
        this.hud.hp = this.hp;
        this.hud.maxHp = this.diff.lives;
        this.hud.drawThreats(this.camera, p.scopeBlend);
      }
    }
    audio.update();
    this.composer.render();
  }
}
