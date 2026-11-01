import * as THREE from 'three';

/**
 * Globale Shader-Erweiterungen:
 * - Hoehennebel mit Sonnenstreuung (ersetzt den flachen FogExp2 in allen Materialien)
 * - vorberechnete Bodenbeleuchtung (Gelaende- und Baumschatten auf Distanz, Verdeckung unter Baeumen)
 * Die Werte stecken in geteilten Uniforms und werden pro Runde gesetzt.
 */

const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
white.needsUpdate = true;

export const atmoUniforms = {
  atmoSunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** Zusaetzliche Nebelfarbe in Sonnenrichtung (linear). */
  atmoSunColor: { value: new THREE.Color(0, 0, 0) },
  /** x: Bezugshoehe, y: Hoehenabfall (1/m), z: Staerke Sonnenstreuung */
  atmoFog: { value: new THREE.Vector4(0, 0.003, 1, 0) },
  atmoGround: { value: white as THREE.Texture },
  /** x0, z0, 1/Breite, 1/Tiefe der Bodenlicht-Karte (z = 0: aus) */
  atmoGroundRect: { value: new THREE.Vector4(0, 0, 0, 0) },
  /** Mitte (x, z) und Radius der Echtzeit-Schatten, w = 1 wenn aktiv */
  atmoShadowFocus: { value: new THREE.Vector4(0, 0, 0, 0) },
};

// ------------------------------------------------------------------ Nebel (global)

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vAtmoRay;
#endif
`;

THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vAtmoRay = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif
`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vAtmoRay;
  uniform vec3 atmoSunDir;
  uniform vec3 atmoSunColor;
  uniform vec4 atmoFog;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
  {
    float fogDist = length(vAtmoRay);
    vec3 fogRd = vAtmoRay / max(fogDist, 1e-3);
    float fogB = max(atmoFog.y, 1e-5);
    float fogK = fogB * fogRd.y * fogDist;
    float fogInt = abs(fogK) > 1e-4 ? (1.0 - exp(-fogK)) / (fogB * fogRd.y) : fogDist;
    float fogOD = fogDensity * exp(-fogB * (cameraPosition.y - atmoFog.x)) * fogInt;
    float fogFactor = 1.0 - exp(-fogOD);
    float fogSun = pow(max(dot(fogRd, atmoSunDir), 0.0), 7.0) * atmoFog.z;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor + atmoSunColor * fogSun, fogFactor);
  }
  #else
    float fogFactor = smoothstep(fogNear, fogFar, length(vAtmoRay));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
  #endif
#endif
`;

const DIRECT_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';
if (!THREE.ShaderChunk.lights_fragment_begin.includes(DIRECT_LINE)) {
  console.warn('atmosphere: lights_fragment_begin hat sich geaendert, Bodenschatten deaktiviert');
}

const GROUND_PARS = /* glsl */ `
#ifdef USE_FOG
  uniform sampler2D atmoGround;
  uniform vec4 atmoGroundRect;
  uniform vec4 atmoShadowFocus;
#endif
`;

const GROUND_MAIN = /* glsl */ `
float atmoSunVis = 1.0;
float atmoAO = 1.0;
#ifdef USE_FOG
{
  vec3 gwp = cameraPosition + vAtmoRay;
  vec2 guv = (gwp.xz - atmoGroundRect.xy) * atmoGroundRect.zw;
  vec4 gs = texture2D(atmoGround, clamp(guv, 0.0, 1.0));
  float gin = atmoGroundRect.z > 0.0 ? step(0.0, guv.x) * step(guv.x, 1.0) * step(0.0, guv.y) * step(guv.y, 1.0) : 0.0;
  #ifdef ATMO_NO_TREE_SHADOW
    float gsun = gs.r;
  #else
    float gfd = distance(gwp.xz, atmoShadowFocus.xy);
    float grt = atmoShadowFocus.w > 0.5 ? smoothstep(atmoShadowFocus.z * 0.62, atmoShadowFocus.z * 0.92, gfd) : 1.0;
    float gsun = gs.r * mix(1.0, gs.g, grt);
  #endif
  atmoSunVis = mix(1.0, gsun, gin);
  atmoAO = mix(1.0, gs.b, gin);
}
#endif
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Nebel- und Bodenlicht-Uniforms anhaengen, Bodenschatten in beleuchtete Materialien einbauen. */
export function patchShader(shader: Shader) {
  if (!shader.fragmentShader.includes('#include <fog_fragment>')) return;
  Object.assign(shader.uniforms, atmoUniforms);
  if (shader.fragmentShader.includes('#include <lights_fragment_begin>')) {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\n' + GROUND_PARS)
      .replace(
        '#include <lights_fragment_begin>',
        GROUND_MAIN + THREE.ShaderChunk.lights_fragment_begin.replace(DIRECT_LINE, DIRECT_LINE + '\n\t\tdirectLight.color *= atmoSunVis;'),
      )
      .replace(
        '#include <aomap_fragment>',
        'reflectedLight.indirectDiffuse *= atmoAO;\nreflectedLight.indirectSpecular *= mix(1.0, atmoAO, 0.7);\n#include <aomap_fragment>',
      );
  }
}

// Alle Standardmaterialien bekommen den Patch automatisch. Materialien mit eigenem
// onBeforeCompile rufen patchShader selbst auf.
THREE.Material.prototype.onBeforeCompile = function (shader: Shader) {
  patchShader(shader);
};

/**
 * Alpha-getestete Karten (Nadeln, Blaetter, Gras) verlieren in kleinen Mipmaps ihre Deckung und
 * verschwinden auf Distanz. Alpha mit dem Mip-Level anheben haelt sie sichtbar.
 */
export function alphaMipFix(shader: Shader, scale = 0.3) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <alphatest_fragment>',
    /* glsl */ `
    #ifdef USE_MAP
    {
      vec2 amSize = vec2(textureSize(map, 0));
      vec2 amDx = dFdx(vMapUv * amSize), amDy = dFdy(vMapUv * amSize);
      float amMip = max(0.0, 0.5 * log2(max(dot(amDx, amDx), dot(amDy, amDy))));
      diffuseColor.a *= 1.0 + amMip * ${scale.toFixed(3)};
    }
    #endif
    #include <alphatest_fragment>`,
  );
}

/** Weniger Glanz bei streifendem Blick (Gras und Erde spiegeln kaum). */
export function matte(shader: Shader, k = 0.3) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_physical_fragment>',
    `#include <lights_physical_fragment>\nmaterial.specularColor *= ${k.toFixed(3)};\nmaterial.specularF90 = ${k.toFixed(3)};`,
  );
}

/** Material mit mehreren Patches; eindeutiger Cache-Key, damit Programme nicht vertauscht werden. */
export function customize(mat: THREE.Material, key: string, fn: (shader: Shader) => void) {
  mat.onBeforeCompile = (shader) => {
    fn(shader);
    patchShader(shader);
  };
  mat.customProgramCacheKey = () => key;
}
