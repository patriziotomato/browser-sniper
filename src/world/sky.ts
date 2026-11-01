import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Rng } from '../core/rng';
import { settings } from '../config';
import { atmoUniforms } from './atmosphere';

export type WeatherKind = 'klar' | 'dunst' | 'nebel' | 'regen';

export interface Atmosphere {
  weather: WeatherKind;
  sunElevation: number; // Grad
  sunAzimuth: number; // Grad, 0 = Blickrichtung (-Z)
  fogDensity: number;
  sunDir: THREE.Vector3;
}

const CLOUD_PARS = /* glsl */ `
uniform float cloudCover;
uniform float cloudOpacity;
uniform vec2 cloudOffset;
uniform vec3 cloudSun;
uniform vec3 cloudAmbient;
uniform float skyGain;
float cHash(vec2 p){ p = fract(p*vec2(233.34,851.73)); p += dot(p,p+23.45); return fract(p.x*p.y); }
float cNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(cHash(i), cHash(i+vec2(1,0)), u.x), mix(cHash(i+vec2(0,1)), cHash(i+vec2(1,1)), u.x), u.y);
}
float cFbm(vec2 p){
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++) { s += a*cNoise(p); p = r*p*2.03 + 1.7; a *= 0.5; }
  return s;
}
`;

const CLOUD_MAIN = /* glsl */ `
retColor *= skyGain;
if (cloudOpacity > 0.0 && direction.y > 0.0) {
  // Wolkenschicht als Ebene ueber der Kamera
  vec2 cp = direction.xz / (direction.y + 0.06) * 1.6 + cloudOffset;
  float warp = cFbm(cp*0.35 + 4.0);
  vec2 q = cp + vec2(warp, -warp) * 0.6;
  float n = cFbm(q);
  float thr = 1.0 - cloudCover;
  float dens = smoothstep(thr*0.62, thr*0.62 + 0.28, n);
  float thick = smoothstep(thr*0.62, thr*0.62 + 0.55, n);
  // Selbstschatten: Dichte in Richtung Sonne
  float nt = cFbm(q + vSunDirection.xz * 0.18);
  float toward = smoothstep(thr*0.62, thr*0.62 + 0.55, nt);
  float lit = clamp(0.62 + (thick - toward) * 2.8, 0.0, 1.0) * (1.0 - 0.55*thick);
  float cosS = max(dot(direction, vSunDirection), 0.0);
  vec3 cCol = cloudAmbient * (1.05 - 0.45*thick) + cloudSun * lit;
  cCol += cloudSun * pow(cosS, 12.0) * (1.0 - thick) * 0.6;
  float horizon = smoothstep(0.0, 0.16, direction.y);
  cCol = mix(min(retColor, vec3(2.0)), cCol, 0.45 + 0.55*smoothstep(0.02, 0.4, direction.y));
  retColor = mix(retColor, cCol, dens * horizon * cloudOpacity);
}
`;

/** Sky mit Wolkenschicht. */
function createSky(): Sky {
  const sky = new Sky();
  const m = sky.material;
  m.fragmentShader = m.fragmentShader
    .replace('uniform vec3 up;', 'uniform vec3 up;\n' + CLOUD_PARS)
    .replace('gl_FragColor = vec4( retColor, 1.0 );', CLOUD_MAIN + '\ngl_FragColor = vec4( retColor, 1.0 );');
  Object.assign(m.uniforms, {
    skyGain: { value: 1 },
    cloudCover: { value: 0.4 },
    cloudOpacity: { value: 1 },
    cloudOffset: { value: new THREE.Vector2() },
    cloudSun: { value: new THREE.Color(1, 1, 1) },
    cloudAmbient: { value: new THREE.Color(0.5, 0.6, 0.7) },
  });
  return sky;
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
    // Extinktion pro Meter auf Hoehe des Spielers (Hoehennebel, siehe atmosphere.ts)
    const fogDensity = { klar: 0.00011, dunst: 0.00032, nebel: 0.0008, regen: 0.00055 }[weather];
    const fogFalloff = { klar: 1 / 420, dunst: 1 / 320, nebel: 1 / 140, regen: 1 / 520 }[weather];
    const phi = THREE.MathUtils.degToRad(90 - sunElevation);
    const theta = THREE.MathUtils.degToRad(sunAzimuth);
    // Azimut 0 = -Z
    const sunDir = new THREE.Vector3(Math.sin(theta) * Math.sin(phi), Math.cos(phi), -Math.cos(theta) * Math.sin(phi));
    this.atmo = { weather, sunElevation, sunAzimuth, fogDensity, sunDir };
    const overcast = weather === 'regen' || weather === 'nebel';

    this.sky = createSky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = overcast ? 10 : weather === 'dunst' ? 5 : 2.4;
    u.rayleigh.value = overcast ? 0.8 : weather === 'dunst' ? 1.6 : 2.0;
    u.mieCoefficient.value = overcast ? 0.015 : weather === 'dunst' ? 0.007 : 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(sunDir);
    u.cloudCover.value = { klar: rng.range(0.22, 0.42), dunst: rng.range(0.35, 0.55), nebel: 0.9, regen: 0.95 }[weather];
    u.cloudOffset.value.set(rng.range(0, 100), rng.range(0, 100));
    scene.add(this.sky);

    const lowSun = THREE.MathUtils.smoothstep(sunElevation, 2, 25);
    const sunColor = new THREE.Color().setRGB(1.0, 0.70 + 0.25 * lowSun, 0.46 + 0.44 * lowSun);
    this.sun = new THREE.DirectionalLight(sunColor, overcast ? 1.3 : 3.0 + lowSun * 0.6);
    this.sun.castShadow = settings.quality.shadows;
    this.sun.shadow.mapSize.set(settings.quality.shadowMap, settings.quality.shadowMap);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera;
    sc.near = 1;
    sc.far = 800;
    scene.add(this.sun, this.sun.target);

    // Farben des Himmels auslesen: Nebel = Horizont, Wolken-Umgebungslicht = Zenit
    const envScene = new THREE.Scene();
    const skyCopy = createSky();
    skyCopy.scale.setScalar(1000);
    skyCopy.material.uniforms = THREE.UniformsUtils.clone(this.sky.material.uniforms);
    envScene.add(skyCopy);
    const su = skyCopy.material.uniforms;
    su.cloudOpacity.value = 0;
    const az = (deg: number, elev: number) => {
      const a = theta + THREE.MathUtils.degToRad(deg), e = THREE.MathUtils.degToRad(elev);
      return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
    };
    const side = this.readSky(envScene, [az(90, 1.5), az(-90, 1.5), az(180, 1.5)]);
    const toward = this.readSky(envScene, [az(0, 1.2)]);
    const zenith = this.readSky(envScene, [new THREE.Vector3(0.001, 1, 0), az(180, 50)]);
    let fogColor: THREE.Color;
    if (side && toward && zenith) {
      // Himmel auf eine feste Horizonthelligkeit bringen, sonst ueberstrahlt er das Gelaende
      const lum = side.r * 0.2126 + side.g * 0.7152 + side.b * 0.0722;
      const gain = THREE.MathUtils.clamp((overcast ? 0.62 : weather === 'dunst' ? 0.78 : 0.72) / Math.max(lum, 1e-3), 0.25, 1.5);
      u.skyGain.value = su.skyGain.value = gain;
      side.multiplyScalar(gain);
      toward.multiplyScalar(gain);
      zenith.multiplyScalar(gain);
      fogColor = side;
      if (overcast) fogColor.lerp(new THREE.Color(0.55, 0.58, 0.62), 0.5);
      atmoUniforms.atmoSunColor.value.copy(toward).sub(fogColor);
      const c = atmoUniforms.atmoSunColor.value;
      c.setRGB(Math.max(0, c.r), Math.max(0, c.g), Math.max(0, c.b)).multiplyScalar(overcast ? 0.3 : 0.8);
      su.cloudAmbient.value.copy(zenith).lerp(fogColor, 0.5);
    } else {
      fogColor = overcast ? new THREE.Color(0x9aa3ab) : new THREE.Color().setRGB(0.62, 0.7, 0.8);
      if (!overcast) fogColor.lerp(new THREE.Color(0xd9b38c), (1 - lowSun) * 0.35);
      atmoUniforms.atmoSunColor.value.setRGB(0.3, 0.22, 0.12);
      su.cloudAmbient.value.copy(fogColor);
    }
    // Wolken: Sonnenlicht und Umgebung, abhaengig vom Wetter
    su.cloudSun.value.copy(sunColor).multiplyScalar(overcast ? 0.25 : 0.95);
    if (overcast) su.cloudAmbient.value.multiplyScalar(0.85);
    su.cloudOpacity.value = 1;
    u.cloudSun.value.copy(su.cloudSun.value);
    u.cloudAmbient.value.copy(su.cloudAmbient.value);

    // Umgebungslicht aus dem Himmel (mit Wolken)
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0, 0.1, 2000).texture;
    scene.environmentIntensity = overcast ? 0.62 : 0.42;
    pmrem.dispose();
    skyCopy.geometry.dispose();
    skyCopy.material.dispose();

    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4030, overcast ? 0.3 : 0.12);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(fogColor, fogDensity);
    renderer.setClearColor(fogColor);
    atmoUniforms.atmoSunDir.value.copy(sunDir);
    atmoUniforms.atmoFog.value.set(100, fogFalloff, 1, 0);

    if (weather === 'regen') this.createRain();
  }

  /** Hoehe, auf die sich die Nebeldichte bezieht (Augenhoehe des Spielers). */
  setFogBase(y: number) {
    atmoUniforms.atmoFog.value.x = y;
  }

  /** Mittlere Himmelsfarbe (linear, HDR) in den angegebenen Richtungen. */
  private readSky(scene: THREE.Scene, dirs: THREE.Vector3[]): THREE.Color | null {
    try {
      const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType, depthBuffer: false });
      const cam = new THREE.PerspectiveCamera(3, 1, 0.1, 5000);
      const buf = new Float32Array(4 * 4 * 4);
      const sum = new THREE.Color(0, 0, 0);
      const prev = this.renderer.getRenderTarget();
      for (const d of dirs) {
        cam.position.set(0, 0, 0);
        cam.lookAt(d);
        cam.updateMatrixWorld();
        this.renderer.setRenderTarget(rt);
        this.renderer.render(scene, cam);
        this.renderer.readRenderTargetPixels(rt, 0, 0, 4, 4, buf);
        for (let i = 0; i < 16; i++) sum.r += buf[i * 4] / 16, sum.g += buf[i * 4 + 1] / 16, sum.b += buf[i * 4 + 2] / 16;
      }
      this.renderer.setRenderTarget(prev);
      rt.dispose();
      sum.multiplyScalar(1 / dirs.length);
      if (!isFinite(sum.r + sum.g + sum.b) || sum.r + sum.g + sum.b <= 0) return null;
      return sum;
    } catch {
      return null;
    }
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
    atmoUniforms.atmoShadowFocus.value.set(center.x, center.z, radius, s.castShadow && this.renderer.shadowMap.enabled ? 1 : 0);
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
    // Wolken ziehen langsam mit dem Wind
    const off = this.sky.material.uniforms.cloudOffset.value as THREE.Vector2;
    off.x += (wind.x * 0.0012 + 0.0006) * dt;
    off.y += wind.z * 0.0012 * dt;
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
