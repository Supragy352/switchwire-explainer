/* Switchwire 3D viewer: loads the Fusion export, poses the moving axes, draws belts,
   follows section views, ghosts unrelated parts, names clicked parts.
   Coordinates in this file are Fusion's: cm, Z up, front = -Y. */
(function () {
  'use strict';
  const stage = document.getElementById('stage');
  const canvas = stage.querySelector('canvas');
  const statusEl = stage.querySelector('.stage-status');
  const labelEl = stage.querySelector('.stage-label');
  const pickEl = stage.querySelector('.stage-pick');
  const hintEl = stage.querySelector('.stage-hint');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Fusion cm (x, y, z) -> three.js world metres (x, z, -y)
  const F = (x, y, z) => new THREE.Vector3(x / 100, z / 100, -y / 100);

  // Fail before the 6 MB download if anything the loader needs is missing (CDN down, Safari < 16.4).
  // window.SW stays undefined; every caller checks for it.
  const unavailable = (why) => { statusEl.textContent = `The 3D model is unavailable (${why}). The text and widgets still work.`; };
  if (!window.THREE || !THREE.OrbitControls || !THREE.GLTFLoader) return unavailable('three.js did not load');
  if (!('DecompressionStream' in window)) return unavailable('this browser is too old to unpack it');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (e) {
    return unavailable('this browser could not start WebGL');
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  // Minimal studio environment so metal parts have something to reflect (RoomEnvironment isn't in the r147 classic build)
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial({ color: 0x3c4045, side: THREE.BackSide })));
  [[0, 4.9, 0, -Math.PI / 2, 0], [4.9, 1, 1, 0, -Math.PI / 2], [-3, 2, 4.9, 0, Math.PI]].forEach(([x, y, z, rx, ry]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(5, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0); env.add(m);
  });
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(1.5, 2.5, 2);
  scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x30343a, 0.35));

  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 30);
  camera.position.copy(F(85, -115, 75));
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.copy(F(0, -5, 22));
  controls.minDistance = 0.08;
  controls.maxDistance = 4;
  controls.listenToKeyEvents(canvas); // arrow keys pan when the canvas has focus

  // Touch: one finger must still scroll the page past the sticky stage. A tap arms the
  // controls; scrolling the page (by touching the text) disarms them again.
  const coarse = matchMedia('(pointer: coarse)').matches;
  function armTouch(on) {
    controls.enabled = on;
    canvas.style.touchAction = on ? 'none' : 'pan-y'; // OrbitControls sets 'none' in its constructor
    stage.classList.toggle('is-armed', on);
    hintEl.textContent = on ? 'Drag to orbit · pinch to zoom · scroll the text to let go' : 'Tap the model to rotate it';
  }
  if (coarse) {
    armTouch(false);
    addEventListener('scroll', () => controls.enabled && armTouch(false), { passive: true });
  }

  function applyTheme() {
    glowCache.forEach((m) => m.dispose());
    glowCache.clear(); // accent differs per theme
    scene.background = new THREE.Color(css('--stage'));
    ghostMat.color.set(css('--ghost')).convertSRGBToLinear();
    beltMat.default.color.set(css('--belt')).convertSRGBToLinear();
    if (root) { applyFocus(lastFocus.objs, lastFocus.highlight); shown ? ghostBelts() : paintBelts(); }
    requestRender();
  }

  // ---------- render on demand ----------
  let pending = false;
  const tweens = [];
  function requestRender() {
    if (!pending) { pending = true; requestAnimationFrame(frame); }
  }
  function frame(t) {
    pending = false;
    let active = controls.update();
    for (let i = tweens.length - 1; i >= 0; i--) {
      if (tweens[i](t)) active = true; else tweens.splice(i, 1);
    }
    renderer.render(scene, camera);
    if (active) requestRender();
  }
  controls.addEventListener('change', requestRender);
  canvas.addEventListener('webglcontextrestored', requestRender);
  new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }).observe(canvas);

  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  function flyTo(pos, target) {
    if (reduceMotion) {
      camera.position.copy(pos); controls.target.copy(target); requestRender(); return;
    }
    const p0 = camera.position.clone(), t0 = controls.target.clone();
    let start = null;
    tweens.length = 0;
    tweens.push((t) => {
      if (start === null) start = t;
      const u = Math.min(1, (t - start) / 750), e = ease(u);
      camera.position.lerpVectors(p0, pos, e);
      controls.target.lerpVectors(t0, target, e);
      return u < 1;
    });
    requestRender();
  }

  // ---------- materials ----------
  const ghostMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.1, depthWrite: false, roughness: 1, metalness: 0 });
  const beltMat = {
    default: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }),
    a: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 }),
    b: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 }),
    y: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 }),
  };

  // ---------- model state ----------
  let root = null, fusionRoot = null;
  const byName = new Map();      // original Fusion name -> [Object3D]
  const meshes = [];
  const pose = { x: 0, y: 0, z: 0 };
  let movers = [], spinners = [], belts = null;
  let currentView = 'overview', shown = false;
  let lastFocus = { objs: [], highlight: false };
  const readyCbs = [];

  const MOVE = {
    y: ['Bed Assembly:1'],
    z: ['X Axis Assembly:1', 'keybak_end:1'],
    x: ['X Carriage 2.4 v9:1', 'Stealthburner_Assembly:1', 'CW2_Assembly:1', 'ADXL_Assembly - Generic:1',
        'SB TOOLHEAD-Revo Voron:1', 'MGN12H, LINEAR GUIDE BLOCK v1:1'],
  };
  // travel limits in cm, from the rail and carriage-stop geometry
  const LIMIT = { x: [-11.5, 11.5], y: [-11, 11], z: [0, 24] };
  const HIDE_ALWAYS = ['Y Carrier Drill Guide:1', 'X Belt:1', 'Z Belt:1', 'Y Belt:1'];

  function named(n) { return byName.get(n) || []; }
  function matching(substrs) {
    const out = [];
    for (const [name, objs] of byName) if (substrs.some((s) => name.includes(s))) out.push(...objs);
    return out;
  }

  // ---------- loading ----------
  async function load() {
    // base64 text of a gzipped GLB: artifacts only serve web file types
    const url = 'models/switchwire.b64.txt';
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      // With Content-Encoding (GitHub Pages gzips text) Content-Length is the compressed size, not what we read
      const total = res.headers.get('content-encoding') ? 0 : +res.headers.get('content-length');
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        statusEl.textContent = total
          ? `Loading the CAD model… ${Math.min(99, Math.round((got / total) * 100))}%`
          : `Loading the CAD model… ${(got / 1e6).toFixed(1)} MB`;
      }
      statusEl.textContent = 'Unpacking 730 000 triangles…';
      const b64 = atob((await new Blob(chunks).text()).trim());
      const gz = new Uint8Array(b64.length);
      for (let i = 0; i < b64.length; i++) gz[i] = b64.charCodeAt(i);
      const buf = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      new THREE.GLTFLoader().parse(buf, '', onModel, (err) => fail(err));
    } catch (err) { fail(err); }
  }
  function fail(err) {
    console.error(err);
    statusEl.textContent = `The 3D model did not load (${err.message || err}). The text and widgets still work.`;
  }

  function onModel(gltf) {
    root = gltf.scene;
    const assoc = gltf.parser.associations;
    const jsonNodes = gltf.parser.json.nodes;
    root.traverse((o) => {
      const a = assoc.get(o);
      const orig = a && a.nodes !== undefined ? jsonNodes[a.nodes].name : null;
      if (orig) {
        o.userData.fname = orig;
        if (!byName.has(orig)) byName.set(orig, []);
        byName.get(orig).push(o);
      }
      if (o.isMesh) { o.userData.mat = o.material; meshes.push(o); }
    });
    fusionRoot = named('Switchwire')[0];
    HIDE_ALWAYS.forEach((n) => named(n).forEach((o) => (o.visible = false)));
    scene.add(root);
    root.updateMatrixWorld(true);

    // movers: unit vectors of Fusion X/Y/Z expressed in each node's parent frame
    for (const axis of ['x', 'y', 'z']) {
      for (const o of MOVE[axis].flatMap(named)) {
        const p = o.parent, w0 = o.getWorldPosition(new THREE.Vector3());
        const d = { x: F(1, 0, 0), y: F(0, 1, 0), z: F(0, 0, 1) }[axis];
        const local = p.worldToLocal(w0.clone().add(d)).sub(p.worldToLocal(w0.clone()));
        movers.push({ o, axis, base: o.position.clone(), unit: local });
      }
    }
    // pulleys that spin with their belts: [node, Fusion centre, Fusion axis]
    const spinDefs = [
      ['GT2 20T 6mm Powge v2:3', [-16.94, -2.57, 8.80], [0, 1, 0], 'a'],
      ['GT2 20T 6mm Powge v2:2', [16.94, -2.23, 8.79], [0, 1, 0], 'b'],
      ['GT2 20T 6mm Powge v2:1', [0, 12.30, 7.34], [0, 0, 1], 'y'],
    ];
    for (const [n, c, ax, key] of spinDefs) {
      const o = named(n)[0];
      if (!o) continue;
      const p = o.parent;
      const cw = F(...c), aw = F(...ax).normalize();
      const pivot = p.worldToLocal(cw.clone());
      const axisLocal = p.worldToLocal(cw.clone().add(aw)).sub(pivot).normalize();
      o.updateMatrix();
      spinners.push({ o, key, pivot, axis: axisLocal, base: o.matrix.clone() });
      o.matrixAutoUpdate = false;
    }
    buildBelts();
    applyTheme();
    setPose(pose);
    view(currentView, true);
    statusEl.hidden = true;
    stage.classList.add('is-ready');
    readyCbs.splice(0).forEach((cb) => cb());
  }

  // ---------- belts drawn from pulley geometry ----------
  const R = 0.64; // GT2 20T pitch radius, cm
  function corexzPath(s, x, z) {
    // s=+1: motor A belt (left motor, front plane y=-2.9); s=-1: motor B belt (right motor, y=-1.9)
    const cx = 0.25 + x;
    return [
      [cx + s * 2.0, 13.70 + z], [s * 16.94, 13.70 + z], [s * (16.94 + R), 14.34 + z],
      [s * (16.94 + R), 47.5], [s * 16.94, 47.5 + R], [-s * 16.94, 47.5 + R], [-s * (16.94 + R), 47.5],
      [-s * (16.94 + R), 8.8], [-s * 16.94, 8.8 - R], [-s * (16.94 - R), 8.8],
      [-s * (15.61 + R), 12.90 + z], [-s * 15.61, 12.90 + R + z], [cx - s * 2.0, 12.90 + R + z],
    ];
  }
  function yPath(y) {
    const ay = -7.68 + y;
    return [
      [R, ay + 1.6], [R, 12.30], [0, 12.30 + R], [-R, 12.30], [-R, -24.85], [0, -24.85 - R], [R, -24.85], [R, ay - 1.6],
    ];
  }
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  function makeBelt(n, mat) {
    const g = new THREE.Group();
    for (let i = 0; i < n - 1; i++) {
      const m = new THREE.Mesh(unitBox, mat);
      m.matrixAutoUpdate = false;
      m.userData.belt = true;
      g.add(m);
    }
    return g;
  }
  function layBelt(group, pts3, widthDir) {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), n = new THREE.Vector3();
    group.children.forEach((m, i) => {
      a.set(...pts3[i]); b.set(...pts3[i + 1]);
      dir.subVectors(b, a); const len = dir.length(); dir.normalize();
      n.crossVectors(dir, widthDir).normalize();
      m.matrix.makeBasis(dir.clone().multiplyScalar(len + 0.1), widthDir.clone().multiplyScalar(0.6), n.clone().multiplyScalar(0.14));
      m.matrix.setPosition(a.clone().add(b).multiplyScalar(0.5));
    });
  }
  function buildBelts() {
    belts = {
      a: makeBelt(13, beltMat.default), b: makeBelt(13, beltMat.default), y: makeBelt(8, beltMat.default),
    };
    const g = new THREE.Group();
    g.add(belts.a, belts.b, belts.y);
    fusionRoot.add(g);
    belts.group = g;
  }
  function updateBelts() {
    const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
    layBelt(belts.a, corexzPath(+1, pose.x, pose.z).map(([x, z]) => [x, -2.9, z]), Y);
    layBelt(belts.b, corexzPath(-1, pose.x, pose.z).map(([x, z]) => [x, -1.9, z]), Y);
    layBelt(belts.y, yPath(pose.y).map(([x, y]) => [x, y, 7.0]), Z);
  }
  function ghostBelts() {
    for (const k of ['a', 'b', 'y']) belts[k].children.forEach((m) => (m.material = ghostMat));
  }
  function paintBelts() {
    const xz = ['kinematics', 'counterweight', 'belts'].includes(currentView);
    const y = ['yaxis', 'belts'].includes(currentView);
    beltMat.a.color.set(css('--motor-a')).convertSRGBToLinear();
    beltMat.b.color.set(css('--motor-b')).convertSRGBToLinear();
    beltMat.y.color.set(css('--y-axis')).convertSRGBToLinear();
    // uncoloured belts ghost along with everything else when a view focuses on some parts
    const plain = VIEWS[currentView] && VIEWS[currentView].focus ? ghostMat : beltMat.default;
    belts.a.children.forEach((m) => (m.material = xz ? beltMat.a : plain));
    belts.b.children.forEach((m) => (m.material = xz ? beltMat.b : plain));
    belts.y.children.forEach((m) => (m.material = y ? beltMat.y : plain));
  }

  // ---------- pose ----------
  const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
  function setPose(p) {
    for (const k of ['x', 'y', 'z']) if (p[k] !== undefined) pose[k] = clamp(p[k], LIMIT[k]);
    if (root) place();
  }
  // Position everything that moves: axis poses, exploded-view offsets on top, spinning pulleys.
  function place() {
    for (const [o, e] of expl) o.position.copy(e.base);
    for (const m of movers) m.o.position.copy(m.base).addScaledVector(m.unit, pose[m.axis]);
    for (const [o, e] of expl) if (o.matrixAutoUpdate) o.position.addScaledVector(e.off, explodeT);
    // belt displacement per motor (CoreXZ: a = X + Z, b = X - Z) -> pulley angle = s / r
    const travel = { a: pose.x + pose.z, b: pose.x - pose.z, y: -pose.y };
    const T = new THREE.Matrix4(), Rm = new THREE.Matrix4(), Ti = new THREE.Matrix4();
    for (const s of spinners) {
      T.makeTranslation(s.pivot.x, s.pivot.y, s.pivot.z);
      Ti.makeTranslation(-s.pivot.x, -s.pivot.y, -s.pivot.z);
      Rm.makeRotationAxis(s.axis, travel[s.key] / R);
      s.o.matrix.copy(T).multiply(Rm).multiply(Ti).multiply(s.base);
      const e = expl.get(s.o); // spinners have matrixAutoUpdate off, so explode them through the matrix
      if (e) { const m = s.o.matrix.elements; m[12] += e.off.x * explodeT; m[13] += e.off.y * explodeT; m[14] += e.off.z * explodeT; }
    }
    updateBelts();
    belts.group.visible = explodeT === 0; // belts are drawn from pulley positions an explosion breaks
    root.updateMatrixWorld(true);
    requestRender();
  }

  // ---------- exploded views ----------
  // Offsets in Fusion cm at full explosion, along Fusion axes. A child's offset adds to its parent's.
  const EXPLODE = {
    toolhead: {
      'Stealthburner_Assembly:1': [0, -6, 0], 'Stealthburner_Fans:1': [0, -2, 0], 'LEDs:1': [0, -2.5, 0],
      'SB TOOLHEAD-Revo Voron:1': [0, -2.5, 0], 'Toolhead Revo Voron Front:1': [0, -2.5, 0],
      'P6 Assembly (RevC):1': [0, 0, -5], 'PTFE Tube Revo Voron 29.8:1': [0, 0, 2.5],
      'CW2_Assembly:1': [0, 0, 6], 'LDO-36STH20:1': [0, 3, 2], 'BMG_Extruder_Hardware:1': [0, -2.5, 0],
      'ADXL_Assembly - Generic:1': [-5, -3, -3],
    },
    idler: {
      // two idler stacks on one M5 bolt: lift them out of the block, then spread along the shaft
      'M5 1mm Spacer:5': [0, -3.3, 5], 'F695-2RS v1 (1):3': [0, -2.4, 5], 'F695-2RS v1 (2):3': [0, -1.2, 5],
      'M5 1mm Spacer:6': [0, -0.6, 5], 'M5 1mm Spacer:7': [0, -0.3, 5], 'F695-2RS v1 (1):4': [0, 0.6, 5],
      'F695-2RS v1 (2):4': [0, 1.8, 5], 'M5 1mm Spacer:8': [0, 2.4, 5], 'M5x40 SHCS (1):1': [0, -9, 5],
    },
    gantry: {
      'X Motor:1': [-6, 0, -5], 'Z Motor:1': [6, 0, -5],
      'Upper Block - Left:1': [-4, 0, 4], 'Upper Block - Right:1': [4, 0, 4],
      'XZ Block - Left:1': [-7, 0, 0], 'XZ Block - Right:1': [7, 0, 0],
      'Z Bearing Block - Left v3:1': [-3, 6, 0], 'Z Bearing Block - Right:1': [3, 6, 0], 'XZ Cable Cover:1': [3, 6, 4],
      'MGN12 LINEAR GUIDE SUBASSEMBLY, 12H v1 (3):1': [0, -4, 0],
      ...Object.fromEntries(['X Carriage 2.4 v9:1', 'Stealthburner_Assembly:1', 'CW2_Assembly:1', 'ADXL_Assembly - Generic:1',
        'SB TOOLHEAD-Revo Voron:1'].map((n) => [n, [0, -9, 0]])),
    },
    motor: {
      'NEMA17 (Black) v3:3': [0, -8, 0], 'GT2 20T 6mm Powge v2:3': [0, -4, 0],
      'M3x30 SHCS (6):1': [0, 5, 0], 'M3x30 SHCS (6):2': [0, 5, 0], 'M3x30 SHCS (6):3': [0, 5, 0], 'M3x30 SHCS (6):4': [0, 5, 0],
      'Tensioner:2': [0, 0, -4], 'M3x40 SHCS:2': [0, 0, -8], 'M3 Threaded Insert (3):1': [0, 0, -2],
      'M5x16 BHCS (1):1': [-4, 0, 0], 'M5x16 BHCS (1):2': [-4, 0, 0],
    },
    electronics: {
      // boards drop off the printed mounts on the underside of the deck
      'MW RS-25 v1:1': [0, 0, -6], 'Raspberry Pi 3 v1:1': [0, 0, -6], 'BTT SKR MINI E3 V1.2 v2:1': [0, 0, -6],
      'RPi Zero:1': [0, 0, -4], 'meanwell_lrs-350-24_UPDATED v1:1': [0, 0, -8],
      '6020 Fan:1': [0, -6, 0], '6020 Fan (optional) (1):1': [0, -6, 0],
    },
    frame: {
      // verticals and base rails move apart in X, top and cross members in Z; each M8 blind-joint
      // screw stays on the axis of its joint, halfway across the gap
      'HFS6-3030-400:1': [-5, 0, 0], 'HFS6-3030-400:2': [5, 0, 0],
      'MGN12 LINEAR GUIDE SUBASSEMBLY, 12H v1:1': [-5, 0, 0], 'MGN12 LINEAR GUIDE SUBASSEMBLY, 12H v1 (1):1': [5, 0, 0],
      'Z Carriage Stop:1': [-5, 0, 0], 'Z Carriage Stop:2': [5, 0, 0], 'Z Carriage Stop:3': [5, 0, 0],
      'M5x10 BHCS (6):1': [5, 0, 0], 'M5x10 BHCS (7):1': [5, 0, 0], 'M5x10 BHCS (8):1': [-5, 0, 0],
      'HFS6-3030-360:1': [0, 0, 8], 'M8x16 BHCS:1': [-5, 0, 4], 'M8x16 BHCS:2': [5, 0, 4],
      'HFS6-3060-520:1': [-5, 0, -8], 'HFS6-3060-520:2': [5, 0, -8],
      'M8x16 BHCS:7': [-5, 0, -4], 'M8x16 BHCS:8': [5, 0, -4],
      'Foot - TPU (2):1': [-5, 0, -11], 'Foot - TPU (3):1': [-5, 0, -11], 'Foot - TPU:1': [5, 0, -11], 'Foot - TPU (1):1': [5, 0, -11],
      'HFS6-3030-300:1': [0, 0, -8], 'HFS6-3030-300:2': [0, 0, -8],
      'M8x16 BHCS:3': [2.5, 0, -8], 'M8x16 BHCS:4': [2.5, 0, -8], 'M8x16 BHCS:5': [-2.5, 0, -8], 'M8x16 BHCS:6': [-2.5, 0, -8],
      'HFSB5-340:1': [0, 0, -4], 'M5x10 BHCS (8):2': [0, 0, -6], 'M5x10 BHCS (8):3': [0, 0, -6],
    },
  };
  const ebase = new Map(); // object -> its unexploded local position
  const expl = new Map();  // object -> { base, off (local, at t = 1) } for the active set
  let exploded = null, explodeT = 0;
  function explode(name, t) {
    if (!root) { readyCbs.push(() => explode(name, t)); return; }
    const def = EXPLODE[name];
    if (!def) return;
    if (exploded !== name) {
      explodeT = 0; place(); // settle the previous set at its base before measuring
      expl.clear();
      for (const [n, v] of Object.entries(def)) for (const o of named(n)) {
        if (!ebase.has(o)) ebase.set(o, o.position.clone());
        const p = o.parent, w0 = o.getWorldPosition(new THREE.Vector3());
        const off = p.worldToLocal(w0.clone().add(F(...v))).sub(p.worldToLocal(w0.clone()));
        expl.set(o, { base: ebase.get(o), off });
      }
      exploded = name;
    }
    if (currentView !== 'x-' + name) view('x-' + name); // also after a collapse sent the camera elsewhere
    explodeT = Math.max(0, Math.min(1, t));
    place();
  }
  function collapse() {
    if (!exploded || explodeT === 0) return;
    const name = exploded;
    explodeT = 0; place();
    document.dispatchEvent(new CustomEvent('sw:collapse', { detail: name }));
  }

  // ---------- views ----------
  const GROUPS_HIDDEN_OPEN = ['Panels:1', 'Spool Holder v1:1'];
  const VIEWS = {
    overview:      { cam: [85, -115, 75], at: [0, -5, 22], hide: GROUPS_HIDDEN_OPEN, label: 'Whole machine, panels off (S1)' },
    enclosed:      { cam: [95, -130, 85], at: [0, -6, 26], hide: [], label: 'Enclosed, with doors and panels (S2)' },
    kinematics:    { cam: [0, -150, 30], at: [0, -2, 28], hide: GROUPS_HIDDEN_OPEN, focus: ['Gantry:1', 'Counterweight:1'], label: 'CoreXZ gantry from the front (S3)' },
    counterweight: { cam: [-60, 115, 45], at: [-8, 0, 28], hide: GROUPS_HIDDEN_OPEN, focus: ['Gantry:1', 'Counterweight:1'], label: 'Gantry from the rear, Key-Bak counterweight (S4)' },
    frame:         { cam: [80, -110, 60], at: [0, -6, 20], hide: GROUPS_HIDDEN_OPEN, focus: ['Frame:1'], label: 'Bare frame (S5)' },
    rails:         { cam: [26, -36, 22], at: [0, -7, 8.6], hide: [...GROUPS_HIDDEN_OPEN, 'Prusa MK3_Bed_assembly v2:1'], focus: ['MGN12'], label: 'MGN12 rail and carriage (S6)' },
    yaxis:         { cam: [110, -8, 18], at: [0, -6, 8], hide: GROUPS_HIDDEN_OPEN, focus: ['Y Axis Assembly:1'], label: 'Y axis from the side (S9)' },
    belts:         { cam: [42, -58, 38], at: [0, -6, 7], hide: [...GROUPS_HIDDEN_OPEN, 'Prusa MK3_Bed_assembly v2:1'], focus: ['Y Axis Assembly:1'], label: 'Y drive train, bed removed (S10)' },
    motor:         { cam: [-38, -42, 22], at: [-17, -4, 8.5], hide: GROUPS_HIDDEN_OPEN, focus: ['X Motor:1'], label: 'NEMA 17 with GT2 20T pulley (S11)' },
    bed:           { cam: [45, -72, 48], at: [0, -7, 10], hide: GROUPS_HIDDEN_OPEN, focus: ['Bed Assembly:1'], label: 'MK52 bed on the Y carriage (S14)' },
    toolhead:      { cam: [15, -31, 22], at: [0, -8, 16], follow: true, hide: GROUPS_HIDDEN_OPEN, focus: MOVE.x, label: 'StealthBurner toolhead (S15–S16)' },
    extruder:      { cam: [14, -30, 30], at: [0, -7, 21], follow: true, hide: [...GROUPS_HIDDEN_OPEN, 'Stealthburner_Assembly:1'], focus: ['CW2_Assembly:1'], label: 'Clockwork 2 extruder (S17)' },
    electronics:   { cam: [32, -60, 62], at: [0, -9, 3], hide: [...GROUPS_HIDDEN_OPEN, 'Y Axis Assembly:1', '10x11 Chain Y:1'], focus: ['Electronics:1'], label: 'Electronics bay under the bed (S18)' },
    chains:        { cam: [-75, 110, 60], at: [0, 0, 20], hide: GROUPS_HIDDEN_OPEN, focus: ['10x11 Chain'], label: 'Cable chains from the rear (S20)' },
    // exploded views (camera framed for the parts at full explosion)
    'x-toolhead':    { cam: [45, -40, 30], at: [0, -12, 19], fit: true, hide: GROUPS_HIDDEN_OPEN, focus: MOVE.x, label: 'Toolhead, exploded (S15–S17)' },
    'x-idler':       { cam: [-2, -26, 60], at: [-16, -4, 50], fit: true, hide: GROUPS_HIDDEN_OPEN, focus: ['Upper Block - Left:1'], label: 'Upper idler stack, exploded (S12)' },
    'x-gantry':      { cam: [60, -125, 50], at: [0, -3, 26], fit: true, hide: GROUPS_HIDDEN_OPEN, focus: ['Gantry:1'], label: 'CoreXZ gantry, exploded (S3)' },
    'x-motor':       { cam: [-48, -48, 22], at: [-18, -6, 7], fit: true, hide: GROUPS_HIDDEN_OPEN, focus: ['X Motor:1'], label: 'Motor A and its mount, exploded (S11)' },
    'x-electronics': { cam: [35, -80, -30], at: [0, -10, 1], fit: true, hide: [...GROUPS_HIDDEN_OPEN, 'Y Axis Assembly:1', '10x11 Chain Y:1'], focus: ['Electronics:1'], label: 'Electronics bay from below, exploded (S18)' },
    'x-frame':       { cam: [95, -135, 70], at: [0, -7, 22], fit: true, hide: [...GROUPS_HIDDEN_OPEN, 'Y Axis Assembly:1', 'Electronics:1', 'Front Grill:1', 'Rear Grill:1', '10x11 Chain', 'Gantry:1', 'Z Chain Lower Mount:1', 'Counterweight:1'], focus: ['Frame:1'], label: 'Frame and blind joints, exploded (S5)' },
  };

  // Highlighted copies of materials (a red emissive tint), so even black parts stand out.
  const glowCache = new Map();
  function glow(mat) {
    if (!glowCache.has(mat)) {
      const g = mat.clone();
      g.emissive = new THREE.Color(css('--accent')).convertSRGBToLinear().multiplyScalar(0.45);
      glowCache.set(mat, g);
    }
    return glowCache.get(mat);
  }
  function applyFocus(objs, highlight) {
    lastFocus = { objs, highlight };
    const keep = new Set();
    objs.forEach((o) => o.traverse((c) => c.isMesh && keep.add(c)));
    const all = objs.length === 0;
    for (const m of meshes) {
      if (all) m.material = m.userData.mat;
      else if (keep.has(m)) m.material = highlight ? glow(m.userData.mat) : m.userData.mat;
      else m.material = ghostMat;
    }
  }
  function setHidden(names) {
    const hide = new Set(names.flatMap((n) => matching([n])));
    for (const [, objs] of byName) for (const o of objs) {
      if (!HIDE_ALWAYS.includes(o.userData.fname)) o.visible = !hide.has(o);
    }
  }
  function followOffset(v) {
    return v.follow ? F(pose.x, 0, pose.z) : new THREE.Vector3();
  }
  // The preset cameras were framed for a stage about 0.75 wide per unit height; back off on narrower stages.
  const REF_ASPECT = 0.75;
  function view(name, instant) {
    const v = VIEWS[name];
    if (!v) return;
    // re-entering the current view (widget hover, same-view scroll) must not throw away the reader's orbit
    if (root && name === currentView && !instant && !shown) return;
    if (exploded && name !== 'x-' + exploded) collapse();
    currentView = name;
    shown = false;
    labelEl.textContent = v.label;
    pickEl.hidden = true;
    if (!root) return;
    setHidden(v.hide);
    applyFocus(v.focus ? matching(v.focus) : []);
    paintBelts();
    const off = followOffset(v);
    let at = F(...v.at).add(off);
    let pos = F(...v.cam).add(off).sub(at).multiplyScalar(Math.max(1, REF_ASPECT / camera.aspect)).add(at);
    if (v.fit) [pos, at] = fitExploded(v, pos.sub(at).normalize());
    if (instant) { tweens.length = 0; camera.position.copy(pos); controls.target.copy(at); requestRender(); }
    else flyTo(pos, at);
  }

  // Frame the focus parts as they sit at full explosion, looking along dir.
  function fitExploded(v, dir) {
    const keep = explodeT;
    explodeT = 1; place();
    const box = new THREE.Box3();
    matching(v.focus).forEach((o) => box.expandByObject(o));
    explodeT = keep; place();
    // smallest distance along dir that keeps all eight box corners inside the frustum
    const c = box.getCenter(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).negate().normalize();
    const up = new THREE.Vector3().crossVectors(right, dir.clone().negate());
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * camera.aspect;
    let d = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      const z = p.dot(dir);
      d = Math.max(d, z + Math.abs(p.dot(right)) / tanH, z + Math.abs(p.dot(up)) / tanV);
    }
    return [c.clone().addScaledVector(dir, d * 1.12), c];
  }

  // Focus arbitrary parts by name (BOM rows): ghost the rest and frame them.
  function show(substrs, label) {
    if (!root) { readyCbs.push(() => show(substrs, label)); return; }
    const objs = matching(substrs).filter((o) => !HIDE_ALWAYS.includes(o.userData.fname));
    if (!objs.length) return;
    collapse();
    shown = true;
    pickEl.hidden = true;
    setHidden(GROUPS_HIDDEN_OPEN.filter((g) => !substrs.some((s) => g.includes(s))));
    applyFocus(objs, true);
    ghostBelts();
    const box = new THREE.Box3();
    objs.forEach((o) => box.expandByObject(o));
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.03);
    const dir = camera.position.clone().sub(controls.target).normalize();
    // fit the narrower of the two fields of view (a tall, thin stage is limited horizontally)
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
    const half = Math.min(halfV, Math.atan(Math.tan(halfV) * camera.aspect));
    const dist = r / Math.sin(half) * 1.6;
    labelEl.textContent = label || substrs.join(', ');
    flyTo(c.clone().addScaledVector(dir, dist), c);
  }

  // ---------- click to name a part ----------
  const ray = new THREE.Raycaster();
  let down = null, multi = false;
  const ptrs = new Set();
  canvas.addEventListener('pointerdown', (e) => {
    ptrs.add(e.pointerId);
    if (ptrs.size === 1) { multi = false; down = [e.clientX, e.clientY]; } else multi = true; // pinch, not a tap
  });
  canvas.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); down = null; });
  canvas.addEventListener('pointerup', (e) => {
    ptrs.delete(e.pointerId);
    if (multi || !root || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    if (coarse && !controls.enabled) armTouch(true);
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }, camera);
    // ghosted parts are see-through, so pick the first solid part behind them
    const hit = ray.intersectObjects(root.children, true).find((h) => h.object.material !== ghostMat && visibleChain(h.object));
    if (!hit) { pickEl.hidden = true; return; }
    if (hit.object.userData.belt) { pickEl.textContent = 'GT2 belt, 6 mm (drawn from the pulley positions)'; pickEl.hidden = false; return; }
    const path = [];
    for (let o = hit.object; o && o !== root; o = o.parent) {
      const n = o.userData.fname;
      if (n && /:\d+$/.test(n)) path.unshift(n.replace(/:\d+$/, ''));
    }
    pickEl.textContent = path.length ? path.slice(0, 1).concat(path.length > 1 ? path.slice(-1) : []).join(' › ') : 'Part';
    pickEl.hidden = false;
  });
  function visibleChain(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }

  // ---------- theme ----------
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => root && applyTheme());
  new MutationObserver(() => root && applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  window.SW = {
    setPose,
    view,
    show,
    explode,
    onReady(cb) { root ? cb() : readyCbs.push(cb); },
  };
  scene.background = new THREE.Color(css('--stage'));
  requestRender();
  load();
})();
