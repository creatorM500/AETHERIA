import * as THREE from 'three';
import type { GlobeTextureMode } from '../shared/types.ts';

// Simplified, accurate world landmass polygons in [lng, lat] degrees
const CONTINENT_POLYGONS: Array<Array<[number, number]>> = [
  // North America
  [
    [-168, 65], [-162, 55], [-152, 60], [-140, 60], [-130, 54], [-124, 48],
    [-124, 40], [-118, 34], [-112, 29], [-105, 20], [-96, 16], [-88, 15],
    [-83, 10], [-78, 8], [-82, 12], [-87, 21], [-90, 21], [-97, 22],
    [-97, 26], [-90, 29], [-83, 29], [-81, 25], [-80, 31], [-75, 35],
    [-74, 40], [-70, 42], [-66, 45], [-60, 46], [-55, 51], [-62, 59],
    [-72, 62], [-82, 64], [-95, 69], [-115, 71], [-135, 70], [-156, 71],
  ],
  // Greenland
  [
    [-52, 60], [-42, 60], [-34, 68], [-20, 75], [-22, 82], [-45, 83],
    [-62, 78], [-58, 70],
  ],
  // South America
  [
    [-78, 9], [-72, 11], [-62, 10], [-52, 4], [-48, 0], [-38, -4],
    [-35, -7], [-38, -14], [-40, -21], [-46, -24], [-52, -32], [-58, -38],
    [-64, -42], [-67, -48], [-68, -55], [-74, -52], [-75, -44], [-72, -35],
    [-71, -24], [-70, -18], [-77, -12], [-81, -5], [-79, 2],
  ],
  // Europe
  [
    [-9, 37], [-9, 43], [-2, 43], [-4, 48], [2, 51], [8, 54], [9, 57],
    [5, 60], [10, 64], [18, 69], [28, 71], [40, 68], [58, 69], [60, 56],
    [50, 46], [42, 43], [36, 45], [29, 41], [24, 38], [22, 36], [16, 38],
    [13, 41], [10, 44], [5, 43], [0, 39], [-5, 36],
  ],
  // UK & Ireland
  [
    [-6, 50], [1, 51], [0, 55], [-3, 58], [-7, 57], [-6, 52],
  ],
  // Africa
  [
    [-17, 15], [-16, 21], [-12, 28], [-6, 35], [10, 37], [12, 33], [22, 32],
    [32, 31], [36, 26], [42, 13], [51, 12], [49, 4], [41, -2], [40, -11],
    [35, -20], [31, -29], [25, -34], [18, -34], [15, -26], [12, -16],
    [12, -6], [9, 4], [2, 6], [-8, 5], [-15, 11],
  ],
  // Madagascar
  [
    [44, -25], [47, -25], [50, -16], [49, -12], [44, -17],
  ],
  // Asia
  [
    [29, 41], [36, 36], [35, 31], [42, 13], [54, 17], [59, 22], [56, 26],
    [49, 30], [56, 27], [66, 25], [72, 21], [77, 8], [82, 16], [89, 22],
    [95, 16], [99, 10], [103, 2], [105, 9], [109, 16], [108, 22], [116, 23],
    [121, 30], [120, 36], [126, 38], [129, 35], [131, 42], [140, 48],
    [142, 54], [156, 52], [162, 60], [176, 66], [168, 70], [140, 73],
    [108, 76], [78, 73], [60, 69], [58, 56], [48, 46], [40, 43], [36, 45],
  ],
  // Japan
  [
    [130, 31], [135, 34], [140, 36], [142, 41], [145, 44], [140, 44],
    [137, 38], [132, 34],
  ],
  // Indonesia / Borneo / Sumatra
  [
    [96, 5], [105, -5], [114, -8], [119, -4], [117, 4], [109, 2], [102, 1],
  ],
  // Australia
  [
    [114, -22], [122, -17], [131, -12], [136, -12], [141, -16], [143, -11],
    [150, -21], [153, -28], [150, -37], [141, -38], [134, -34], [126, -32],
    [116, -35], [114, -28],
  ],
  // New Zealand
  [
    [167, -46], [173, -42], [178, -37], [174, -36], [170, -42],
  ],
  // Antarctica rim
  [
    [-180, -72], [-120, -73], [-60, -65], [0, -70], [60, -68], [120, -67],
    [180, -72], [180, -90], [-180, -90],
  ],
];

const URBAN_HUBS: Array<[number, number, number]> = [
  [-99.13, 19.43, 1.0], // CDMX
  [-74.0, 40.71, 1.0],  // NYC
  [-118.24, 34.05, 0.9], // LA
  [-87.62, 41.87, 0.8], // Chicago
  [-46.63, -23.55, 0.95], // Sao Paulo
  [-58.38, -34.6, 0.8], // Buenos Aires
  [-0.12, 51.5, 1.0],   // London
  [2.35, 48.85, 0.95],  // Paris
  [-3.7, 40.41, 0.85],  // Madrid
  [13.4, 52.52, 0.8],   // Berlin
  [37.61, 55.75, 0.9],  // Moscow
  [31.23, 30.04, 0.9],  // Cairo
  [3.37, 6.52, 0.8],    // Lagos
  [55.27, 25.2, 0.9],   // Dubai
  [72.87, 19.07, 0.95], // Mumbai
  [77.2, 28.61, 0.95],  // Delhi
  [103.82, 1.35, 0.9],  // Singapore
  [116.4, 39.9, 1.0],   // Beijing
  [121.47, 31.23, 1.0], // Shanghai
  [114.16, 22.31, 0.95],// HK
  [139.69, 35.68, 1.0], // Tokyo
  [126.97, 37.56, 0.9], // Seoul
  [151.2, -33.86, 0.85],// Sydney
];

function lngToX(lng: number, width: number): number {
  return ((lng + 180) / 360) * width;
}

function latToY(lat: number, height: number): number {
  return ((90 - lat) / 180) * height;
}

function traceContinents(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.beginPath();
  for (const poly of CONTINENT_POLYGONS) {
    if (poly.length === 0) continue;
    ctx.moveTo(lngToX(poly[0][0], width), latToY(poly[0][1], height));
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(lngToX(poly[i][0], width), latToY(poly[i][1], height));
    }
    ctx.closePath();
  }
}

export function createGlobeTextures(
  mode: GlobeTextureMode,
  maxAnisotropy: number,
  highRes = true
): {
  colorMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const width = highRes ? 4096 : 2048;
  const height = highRes ? 2048 : 1024;

  // 1. Albedo / Dynamic Visual Map
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext('2d')!;

  // Ocean base gradient
  const oceanGrad = ctx.createLinearGradient(0, 0, 0, height);
  if (mode === 'satellite') {
    oceanGrad.addColorStop(0, '#0c233a');
    oceanGrad.addColorStop(0.2, '#071a30');
    oceanGrad.addColorStop(0.5, '#092642');
    oceanGrad.addColorStop(0.8, '#071a30');
    oceanGrad.addColorStop(1, '#0d263e');
  } else if (mode === 'godseye') {
    oceanGrad.addColorStop(0, '#031222');
    oceanGrad.addColorStop(0.5, '#051a30');
    oceanGrad.addColorStop(1, '#031222');
  } else if (mode === 'thermal') {
    oceanGrad.addColorStop(0, '#040811');
    oceanGrad.addColorStop(0.5, '#070e1c');
    oceanGrad.addColorStop(1, '#040811');
  } else {
    oceanGrad.addColorStop(0, '#0f1c2e');
    oceanGrad.addColorStop(0.5, '#13273f');
    oceanGrad.addColorStop(1, '#0f1c2e');
  }
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle bathymetry / ocean grid
  ctx.strokeStyle =
    mode === 'godseye'
      ? 'rgba(34, 211, 238, 0.16)'
      : mode === 'thermal'
        ? 'rgba(6, 182, 212, 0.08)'
        : mode === 'topo'
          ? 'rgba(148, 163, 184, 0.14)'
          : 'rgba(56, 189, 248, 0.06)';
  ctx.lineWidth = 1;
  for (let lng = -180; lng <= 180; lng += 15) {
    const x = lngToX(lng, width);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = latToY(lat, height);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Continent fill
  ctx.save();
  traceContinents(ctx, width, height);
  if (mode === 'satellite') {
    const landGrad = ctx.createLinearGradient(0, 0, 0, height);
    landGrad.addColorStop(0, '#d8e4ec'); // Arctic ice
    landGrad.addColorStop(0.18, '#2d4a3e');
    landGrad.addColorStop(0.35, '#3b5b42');
    landGrad.addColorStop(0.48, '#7a6f49'); // Subtropical arid belt
    landGrad.addColorStop(0.62, '#2d5a3b'); // Equatorial rainforest
    landGrad.addColorStop(0.82, '#4a5a44');
    landGrad.addColorStop(0.92, '#cfdce6'); // Antarctica
    ctx.fillStyle = landGrad;
    ctx.fill();
    ctx.clip();

    // Fine topographic relief shading & micro-ridges (no large circular blobs)
    for (let i = 0; i < 650; i++) {
      const rx = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
      const ry = ((Math.sin(i * 78.233) * 19341.123) % 1 + 1) % 1;
      const rw = 4 + (i % 14);
      const rh = 2 + (i % 5);
      ctx.fillStyle =
        i % 3 === 0
          ? 'rgba(15, 36, 26, 0.14)'
          : i % 3 === 1
            ? 'rgba(134, 118, 82, 0.1)'
            : 'rgba(190, 205, 175, 0.08)';
      ctx.fillRect(rx * width, ry * height, rw, rh);
    }
  } else if (mode === 'godseye') {
    ctx.fillStyle = '#08243b';
    ctx.fill();
    ctx.clip();
    for (let i = 0; i < 500; i++) {
      const rx = ((Math.sin(i * 19.13) * 28411.7) % 1 + 1) % 1;
      const ry = ((Math.sin(i * 41.77) * 13921.3) % 1 + 1) % 1;
      ctx.fillStyle = 'rgba(34, 211, 238, 0.18)';
      ctx.fillRect(rx * width, ry * height, 4 + (i % 10), 2);
    }
  } else if (mode === 'thermal') {
    ctx.fillStyle = '#0d1829';
    ctx.fill();
    ctx.clip();
    for (let i = 0; i < 380; i++) {
      const rx = ((Math.sin(i * 19.13) * 28411.7) % 1 + 1) % 1;
      const ry = ((Math.sin(i * 41.77) * 13921.3) % 1 + 1) % 1;
      ctx.fillStyle = 'rgba(14, 116, 144, 0.14)';
      ctx.fillRect(rx * width, ry * height, 5 + (i % 10), 2);
    }
  } else {
    const topoGrad = ctx.createLinearGradient(0, 0, 0, height);
    topoGrad.addColorStop(0, '#cbd5e1');
    topoGrad.addColorStop(0.25, '#475e4e');
    topoGrad.addColorStop(0.5, '#6b6f50');
    topoGrad.addColorStop(0.75, '#4f6454');
    topoGrad.addColorStop(1, '#cbd5e1');
    ctx.fillStyle = topoGrad;
    ctx.fill();
  }
  ctx.restore();

  // Crisp Coastline Borders
  traceContinents(ctx, width, height);
  ctx.strokeStyle =
    mode === 'godseye'
      ? 'rgba(56, 226, 255, 0.92)'
      : mode === 'thermal'
        ? 'rgba(34, 211, 238, 0.85)'
        : mode === 'topo'
          ? 'rgba(226, 232, 240, 0.65)'
          : 'rgba(125, 211, 252, 0.45)';
  const resScale = highRes ? 1.8 : 1;
  ctx.lineWidth = (mode === 'thermal' || mode === 'godseye' ? 1.8 : 1.25) * resScale;
  ctx.stroke();

  // Urban Node Clusters / City Lights
  for (const [lng, lat, intensity] of URBAN_HUBS) {
    const x = lngToX(lng, width);
    const y = latToY(lat, height);
    const r = (mode === 'thermal' || mode === 'godseye' ? 14 : 9) * resScale;
    const grad = ctx.createRadialGradient(x, y, 0.5, x, y, r);
    if (mode === 'godseye') {
      grad.addColorStop(0, `rgba(103, 232, 249, ${0.95 * intensity})`);
      grad.addColorStop(0.5, `rgba(14, 165, 233, ${0.5 * intensity})`);
      grad.addColorStop(1, 'rgba(6, 182, 212, 0)');
    } else if (mode === 'thermal') {
      grad.addColorStop(0, `rgba(245, 158, 11, ${0.9 * intensity})`);
      grad.addColorStop(0.5, `rgba(6, 182, 212, ${0.45 * intensity})`);
      grad.addColorStop(1, 'rgba(6, 182, 212, 0)');
    } else {
      grad.addColorStop(0, `rgba(253, 224, 71, ${0.75 * intensity})`);
      grad.addColorStop(0.5, `rgba(251, 146, 60, ${0.3 * intensity})`);
      grad.addColorStop(1, 'rgba(251, 146, 60, 0)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2. Bump / Relief Map (grayscale linear)
  const bumpW = highRes ? 2048 : 1024;
  const bumpH = highRes ? 1024 : 512;
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = bumpW;
  bumpCanvas.height = bumpH;
  const bCtx = bumpCanvas.getContext('2d')!;
  bCtx.fillStyle = '#181818';
  bCtx.fillRect(0, 0, bumpW, bumpH);
  traceContinents(bCtx, bumpW, bumpH);
  bCtx.fillStyle = '#8a8a8a';
  bCtx.fill();
  bCtx.strokeStyle = '#ffffff';
  bCtx.lineWidth = highRes ? 3 : 2;
  bCtx.stroke();

  // 3. Roughness Map (oceans satin 0.58 to avoid harsh glare hotspots, land matte 0.92)
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = bumpW;
  roughCanvas.height = bumpH;
  const rCtx = roughCanvas.getContext('2d')!;
  rCtx.fillStyle = '#949494';
  rCtx.fillRect(0, 0, bumpW, bumpH);
  traceContinents(rCtx, bumpW, bumpH);
  rCtx.fillStyle = '#ebebeb';
  rCtx.fill();

  const colorMap = new THREE.CanvasTexture(colorCanvas);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.magFilter = THREE.LinearFilter;
  colorMap.minFilter = THREE.LinearMipmapLinearFilter;
  colorMap.anisotropy = maxAnisotropy;
  colorMap.needsUpdate = true;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.colorSpace = THREE.NoColorSpace;
  bumpMap.anisotropy = maxAnisotropy;
  bumpMap.needsUpdate = true;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.colorSpace = THREE.NoColorSpace;
  roughnessMap.anisotropy = maxAnisotropy;
  roughnessMap.needsUpdate = true;

  return { colorMap, bumpMap, roughnessMap };
}

function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise2D(x: number, y: number, periodX: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  const x0 = ((xi % periodX) + periodX) % periodX;
  const x1 = (x0 + 1) % periodX;
  const a = hash2(x0, yi);
  const b = hash2(x1, yi);
  const c = hash2(x0, yi + 1);
  const d = hash2(x1, yi + 1);

  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export function createCloudTexture(highRes = true): THREE.CanvasTexture {
  const w = highRes ? 1536 : 768;
  const h = highRes ? 768 : 384;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  for (let y = 0; y < h; y++) {
    const v = y / h;
    // Jet stream Coriolis shear by latitude
    const lat = (0.5 - v) * Math.PI;
    const shear = Math.sin(lat * 3.0) * 1.65;
    const bandMask = 0.65 + 0.35 * Math.cos(lat * 2.2);

    for (let x = 0; x < w; x++) {
      const u = x / w;
      const nx = u * 10 + shear * 0.4;
      const ny = v * 5;

      const warp = valueNoise2D(nx * 1.5, ny * 1.5, 15) * 1.1;
      const f1 = valueNoise2D(nx + warp, ny + warp * 0.5, 10);
      const f2 = valueNoise2D(nx * 2 + warp * 1.2, ny * 2, 20) * 0.5;
      const f3 = valueNoise2D(nx * 4, ny * 4, 40) * 0.25;
      const f4 = valueNoise2D(nx * 8, ny * 8, 80) * 0.12;

      const density = (f1 + f2 + f3 + f4) / 1.87;
      const cloud = Math.max(0, (density * bandMask - 0.47) * 2.15);
      const alpha = Math.min(220, Math.round(Math.pow(cloud, 1.35) * 210));

      const idx = (y * w + x) * 4;
      data[idx] = 236;
      data[idx + 1] = 244;
      data[idx + 2] = 255;
      data[idx + 3] = alpha;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function createUrbanAsphaltTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#0c1320';
  ctx.fillRect(0, 0, size, size);

  // Subtle street grid lines
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.24)';
  ctx.lineWidth = 3;
  const step = 128;
  for (let i = 0; i <= size; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  // Fine dashed lane markings + crosswalk ticks
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.38)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([14, 14]);
  for (let i = step / 2; i < size; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function createBuildingFacadeTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, size, size);

  const cols = 12;
  const rows = 24;
  const cw = size / cols;
  const rh = size / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const seed = Math.sin(r * 37.1 + c * 19.7) * 43758.5453;
      const frac = seed - Math.floor(seed);
      if (frac > 0.72) {
        ctx.fillStyle = frac > 0.9 ? 'rgba(56, 189, 248, 0.82)' : 'rgba(226, 232, 240, 0.46)';
      } else if (frac > 0.45) {
        ctx.fillStyle = 'rgba(51, 65, 85, 0.72)';
      } else {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      }
      ctx.fillRect(c * cw + 4, r * rh + 4, cw - 8, rh - 7);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}
