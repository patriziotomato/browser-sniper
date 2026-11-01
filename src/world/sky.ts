import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Rng } from '../core/rng';
import { settings } from '../config';

export type WeatherKind = 'klar' | 'dunst' | 'nebel' | 'regen';

export interface Atmosphere {
  weather: WeatherKind;
  sunElevation: number; // Grad
  sunAzimuth: number; // Grad, 0 = Blickrichtung (-Z)
  fogDensity: number;
  sunDir: THREE.Vector3;
}

export class SkySystem {
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly atmo: Atmosphere;
  private rain?: THREE.LineSegments;
  private rainPos?: Float32Array;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, rng: Rng) {
    const weather = rng.pick<WeatherKind>(['klar', 'klar', 'klar', 'dunst', 'dunst', 'nebel', 'regen']);
    const sunElevation = weather === 'regen' ? rng.range(18, 40) : rng.range(6, 48);
    // Gegenlicht kommt vor: Azimut 0 = Sonne vor dem Spieler (blendet), 180 = Sonne im Ruecken.
    const sunAzimuth = rng.range(-170, 170);
    const fogDensity = { klar: 0.00008, dunst: 0.00017, nebel: 0.00048, regen: 0.0003 }[weather];
    const phi = THREE.MathUtils.degToRad(90 - sunElevation);
    const theta = THREE.MathUtils.degToRad(sunAzimuth);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    // setFromSphericalCoords: theta um Y von +Z aus. Wir wollen 0 = -Z.
    sunDir.set(Math.sin(theta) * Math.sin(phi), Math.cos(phi), -Math.cos(theta) * Math.sin(phi));
    this.atmo = { weather, sunElevation, sunAzimuth, fogDensity, sunDir };

    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    const overcast = weather === 'regen' || weather === 'nebel';
    u.turbidity.value = overcast ? 12 : weather === 'dunst' ? 6 : 3;
    u.rayleigh.value = overcast ? 0.6 : 1.4;
    u.mieCoefficient.value = overcast ? 0.02 : 0.005;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(sunDir);
    scene.add(this.sky);

    // Umgebungslicht aus dem Himmel
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const skyCopy = new Sky();
    skyCopy.scale.setScalar(1000);
    skyCopy.material.uniforms = THREE.UniformsUtils.clone(this.sky.material.uniforms);
    envScene.add(skyCopy);
    scene.environment = pmrem.fromScene(envScene, 0, 0.1, 2000).texture;
    scene.environmentIntensity = overcast ? 0.5 : 0.6;

    const lowSun = THREE.MathUtils.smoothstep(sunElevation, 2, 25);
    const sunColor = new THREE.Color().setRGB(1.0, 0.72 + 0.24 * lowSun, 0.5 + 0.42 * lowSun);
    this.sun = new THREE.DirectionalLight(sunColor, overcast ? 1.0 : 2.0 + lowSun * 0.4);
    this.sun.castShadow = settings.quality.shadows;
    this.sun.shadow.mapSize.set(settings.quality.shadowMap, settings.quality.shadowMap);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera;
    sc.near = 1;
    sc.far = 800;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4030, overcast ? 0.5 : 0.3);
    scene.add(this.hemi);

    const fogColor = overcast ? new THREE.Color(0x9aa3ab) : new THREE.Color().setRGB(0.62, 0.7, 0.8);
    if (!overcast) fogColor.lerp(new THREE.Color(0xd9b38c), (1 - lowSun) * 0.35);
    scene.fog = new THREE.FogExp2(fogColor, fogDensity);
    renderer.setClearColor(fogColor);

    if (weather === 'regen') this.createRain();
  }

  /** Schattenkamera auf den Bereich legen, auf den gerade geschaut wird (scharfe Schatten dort). */
  focusShadows(center: THREE.Vector3, radius: number) {
    const s = this.sun;
    const sc = s.shadow.camera;
    sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
    sc.updateProjectionMatrix();
    s.target.position.copy(center);
    s.position.copy(center).addScaledVector(this.atmo.sunDir, 400);
    s.target.updateMatrixWorld();
  }

  private createRain() {
    const n = 6000;
    this.rainPos = new Float32Array(n * 6);
    const geo = new THREE.BufferGeometry();
    for (let i = 0; i < n; i++) this.respawnDrop(i, true, new THREE.Vector3());
    geo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xaab4bf, transparent: true, opacity: 0.35 });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  private respawnDrop(i: number, init: boolean, c: THREE.Vector3) {
    const p = this.rainPos!;
    const x = c.x + (Math.random() - 0.5) * 60, z = c.z + (Math.random() - 0.5) * 60;
    const y = c.y + (init ? Math.random() * 30 - 5 : 25);
    p[i * 6] = x; p[i * 6 + 1] = y; p[i * 6 + 2] = z;
    p[i * 6 + 3] = x; p[i * 6 + 4] = y - 0.5; p[i * 6 + 5] = z;
  }

  update(dt: number, camPos: THREE.Vector3, wind: THREE.Vector3) {
    if (this.rain && this.rainPos) {
      const p = this.rainPos;
      const n = p.length / 6;
      for (let i = 0; i < n; i++) {
        const dy = -14 * dt;
        p[i * 6] += wind.x * dt * 0.6; p[i * 6 + 2] += wind.z * dt * 0.6; p[i * 6 + 1] += dy;
        p[i * 6 + 3] = p[i * 6] - wind.x * 0.03; p[i * 6 + 5] = p[i * 6 + 2] - wind.z * 0.03; p[i * 6 + 4] = p[i * 6 + 1] - 0.5;
        if (p[i * 6 + 1] < camPos.y - 6) this.respawnDrop(i, false, camPos);
      }
      (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
