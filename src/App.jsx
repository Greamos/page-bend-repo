import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

// --- HLSL SHIM PREAMBLE ---
const PREAMBLE = `
const sin=Math.sin, cos=Math.cos, tan=Math.tan, abs=Math.abs, 
      max=Math.max, min=Math.min, sqrt=Math.sqrt, pow=Math.pow,
      floor=Math.floor, ceil=Math.ceil, exp=Math.exp, log=Math.log,
      atan2=Math.atan2, PI=Math.PI, HALF_PI=Math.PI*0.5;
const saturate = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const radians = (d) => d * PI / 180;
const dot = (a, b) => (a.x*b.x + a.y*b.y + (a.z||0)*(b.z||0));
const length = (a) => Math.sqrt(a.x*a.x + a.y*a.y + (a.z*a.z||0));
const float3 = (x, y, z) => ({x, y, z});
const float2 = (x, y) => ({x, y});
`;

// --- BACKGROUND HLSL-TO-JS TRANSPILER ---
function hlslToJs(code) {
    let js = code;
    
    // 0. SMART STRIPPER: Remove variables already provided by the Lab environment
    js = js.replace(/\b(float|const\s+float)\s+(PI|HALF_PI)\s*=[^;]+;/g, '');
    js = js.replace(/\bfloat3\s+p\s*=\s*float3\([^)]+\)\s*;/g, '');
    js = js.replace(/\bfloat3\s+p\s*=\s*VertexLocalPos\s*;/g, '');

    // 1. C++ Value Copy Fix: Ensure 'let bentPos = p;' creates a clone instead of a reference link
    js = js.replace(/=\s*p\s*;/g, '= float3(p.x, p.y, p.z);');

    // NEW: Handle float2 vector subtraction (a - b) -> {x: a.x - b.x, y: a.y - b.y}
    js = js.replace(
        /float2\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)\s*-\s*float2\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/g,
        '{x: $1 - $3, y: $2 - $4}'
    );

    // 2. Remove manual casts like (float3)
    js = js.replace(/\(\s*(float|float2|float3|float4|int)\s*\)/g, '');
    
    // 3. Convert HLSL variable types to JS 'let'
    js = js.replace(/\b(float|float2|float3|float4|int)\b(?!\s*\()/g, 'let');
    
    // 4. Convert HLSL sincos(a, s, c) to JS
    js = js.replace(/sincos\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/g, 
        '{ const _r = sincos($1); $2 = _r.s; $3 = _r.c; }');
        
    // 5. UE5 Custom Fix: Handle "bentPos.xy +=" specifically so you can copy/paste 1:1 UE5 code
    js = js.replace(/bentPos\.xy\s*\+=\s*pullDir\s*\*\s*([^;]+);/g, 
        'bentPos.x += pullDir.x * ($1); bentPos.y += pullDir.y * ($1);');
        
    return js;
}

// --- QUATERNION HELPERS (Gimbal-Lock-Free Arcball) ---
const quat = {
  identity: () => ({w: 1, x: 0, y: 0, z: 0}),
  
  multiply: (a, b) => ({
    w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w
  }),
  
  conjugate: (q) => ({w: q.w, x: -q.x, y: -q.y, z: -q.z}),
  
  fromAxisAngle: (axis, angle) => {
    const ha = angle * 0.5, s = Math.sin(ha);
    const len = Math.sqrt(axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]);
    if (len < 1e-10) return {w: 1, x: 0, y: 0, z: 0};
    const d = 1 / len;
    return {w: Math.cos(ha), x: axis[0]*d*s, y: axis[1]*d*s, z: axis[2]*d*s};
  },
  
  fromYawPitch: (yaw, pitch) => {
    const hy = yaw * 0.5, hp = pitch * 0.5;
    const sy = Math.sin(hy), cy = Math.cos(hy);
    const sp = Math.sin(hp), cp = Math.cos(hp);
    return {w: cp*cy, x: sp*cy, y: cp*sy, z: -sp*sy};
  },
  
  rotate: (q, v) => {
    const qw=q.w, qx=q.x, qy=q.y, qz=q.z;
    const px=v[0], py=v[1], pz=v[2];
    const ix = qw*px + qy*pz - qz*py;
    const iy = qw*py + qz*px - qx*pz;
    const iz = qw*pz + qx*py - qy*px;
    const iw = -qx*px - qy*py - qz*pz;
    return [
      ix*qw + iw*-qx + iy*-qz - iz*-qy,
      iy*qw + iw*-qy + iz*-qx - ix*-qz,
      iz*qw + iw*-qz + ix*-qy - iy*-qx
    ];
  }
};

// --- MASTER PARAMETER DICTIONARY ---
const PARAMS_DICT = {
    FlipProgressAlpha: { min: 0, max: 1, step: 0.01, default: 0.0 }, 
    PeelIntensity:     { min: 0, max: 1, step: 0.01, default: 0.4 }, 
    PeelAngleDegrees:  { min: 0, max: 360, step: 1,  default: 135 },
    FoldTravelDistance:{ min: 0, max: 150, step: 1,  default: 80 },
    PrimaryBendRadius: { min: 1, max: 50, step: 0.1, default: 8 },
    SecondaryBendRadius:{ min: 1, max: 50, step: 0.1, default: 12 },
    TwistAmount:       { min: -0.5, max: 0.5, step: 0.01, default: 0.0 },
    Time:              { min: 0, max: 20, step: 0.1, default: 0.0 },
    SecondaryAlpha:    { min: 0, max: 1, step: 0.01, default: 1.0 },
    GravitySagAmount:  { min: 0, max: 5, step: 0.1, default: 1.0 },
    PeelOriginX:       { min: -50, max: 200, step: 1, default: 100 },
    PeelOriginY:       { min: -200, max: 200, step: 1, default: -70 }, 
    VerticalBendSign:  { min: -1, max: 1, step: 2, default: 1 },
    SecondaryCurlDirection: { min: -1, max: 1, step: 2, default: 1 },
    SpineMaskStart:    { min: 0, max: 50, step: 1, default: 7 },
    SpineMaskEnd:      { min: 0, max: 50, step: 1, default: 17 },
    PageWidth:         { min: 50, max: 200, step: 1, default: 100 },
    PageHeight:        { min: 50, max: 250, step: 1, default: 140 },
};

const DEFAULT_SHADER = `// 'p' = VertexLocalPos
float PI = 3.14159265;
float HALF_PI = 1.57079632;
float3 p = float3(p.x, p.y, p.z);

// ==========================================
// 1. INPUTS & PROGRESS
// ==========================================
float fA = saturate(FlipProgressAlpha);
float pA = saturate(PeelIntensity);
float progress = max(fA, pA);

float rotRad = fA * PI;
float sR, cR;
sincos(rotRad, sR, cR);
float midAir = sR;

float spineMask = smoothstep(SpineMaskStart, SpineMaskEnd, p.x);
float radiusScale = 1.0 + 2.0 * (1.0 - spineMask);

float safeR1 = max(PrimaryBendRadius * radiusScale, 5.0);
float safeR2 = max(SecondaryBendRadius * radiusScale, 5.0);

float sA, cA;
sincos(radians(PeelAngleDegrees), sA, cA);
float2 pullDir = float2(cA, sA);

// ==========================================
// 2. FOLD LINE MATH
// ==========================================
float sweep = FoldTravelDistance * progress;
float twistBias = TwistAmount * p.y;
float d = dot(float2(PeelOriginX, PeelOriginY) - float2(p.x, p.y), pullDir) + sweep + twistBias;
float3 bentPos = p;

// ==========================================
// 3. THE BEND MATH
// ==========================================
float foldMask = smoothstep(0.0, 4.0, d);
float dd = max(0.0, d);
float zO = 0.0, xO = 0.0;
float arc1 = HALF_PI * safeR1;
float arc2 = HALF_PI * safeR2;
float s2 = -SecondaryCurlDirection;

if (dd < arc1) {
    float st, ct;
    sincos(dd / safeR1, st, ct);
    zO = safeR1 * (1.0 - ct);
    xO = dd - (safeR1 * st);
} else if (dd < (arc1 + arc2)) {
    float st, ct;
    sincos((dd - arc1) / safeR2, st, ct);
    float s2R2 = s2 * safeR2;
    zO = safeR1 + (safeR2 * st);
    xO = dd - (safeR1 + s2R2 - s2R2 * ct);
} else {
    float s2R2 = s2 * safeR2;
    zO = safeR1 + safeR2;
    xO = dd - (safeR1 + s2R2 + s2 * (dd - (arc1 + arc2))); 
}

bentPos.z += zO * foldMask * VerticalBendSign;
bentPos.xy += pullDir * (xO * foldMask); 

// ==========================================
// 4. WOBBLE & GRAVITY
// ==========================================
float wobble = sin(Time * 40.0 + bentPos.y * 0.2) * SecondaryAlpha * 0.3;
bentPos.x += wobble * midAir;
bentPos.z += wobble * 0.1 * midAir;

float droopMask = smoothstep(PageWidth * 0.3, PageWidth, p.x);
float zDrop = (GravitySagAmount * 0.08) * droopMask * midAir;
bentPos.z -= zDrop * VerticalBendSign;
bentPos.x -= (zDrop * zDrop * 0.02) * droopMask;

bentPos.x = lerp(p.x, bentPos.x, spineMask);
bentPos.y = lerp(p.y, bentPos.y, spineMask);
bentPos.z = lerp(p.z, bentPos.z, spineMask);

// ==========================================
// 5. Z-CLEARANCE
// ==========================================
float clearance = (midAir * 8.0) + (progress * 1.0);
float liftMask = smoothstep(0.0, PageWidth * 0.4, p.x);
bentPos.z += ((clearance * liftMask) + 0.05) * VerticalBendSign;

// ==========================================
// 6. 180 DEGREE HINGE ROTATION
// ==========================================
float3 finalPos = float3(0,0,0);
finalPos.x = bentPos.x * cR - bentPos.z * sR;
finalPos.y = bentPos.y;
finalPos.z = bentPos.x * sR + bentPos.z * cR;

return float3(finalPos.x - p.x, finalPos.y - p.y, finalPos.z - p.z);`;

function generateMesh(w, h, cols=35, rows=25) {
  const verts = [], faces = [];
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++)
      verts.push([c / cols * w, (r / rows - 0.5) * h, 0]); 
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * (cols + 1) + c;
      faces.push([i, i + 1, i + cols + 2], [i, i + cols + 2, i + cols + 1]);
    }
  return { verts, faces };
}

export default function App() {
  const [code, setCode] = useState(DEFAULT_SHADER);
  const [compileErr, setCompileErr] = useState(null); 
  const [runtimeErr, setRuntimeErr] = useState(null); // Tracks silent math errors
  
  const [params, setParams] = useState(() => {
      const defs = {};
      for (const [k, v] of Object.entries(PARAMS_DICT)) defs[k] = v.default;
      return defs;
  });
  
  const getP = (k) => params[k] !== undefined ? params[k] : PARAMS_DICT[k].default;
  const [vis, setVis] = useState({ mesh: true, crease: true, profileArcs: true, origin: true, displacement: false });
  
  const defaultCam = { quat: quat.multiply(quat.fromAxisAngle([1,0,0], 1.57), quat.fromYawPitch(0, 0.78)), dist: 119, px: 0, py: 0 };
  const [cam, setCam] = useState(defaultCam);
  
  const canvasRef = useRef(), dragRef = useRef(null);
  const compassRef = useRef(), compassDragRef = useRef(null);

  const shaderFn = useMemo(() => {
    try {
      const translatedCode = hlslToJs(code);
      const body = PREAMBLE + `const sincos = (a) => ({s: Math.sin(a), c: Math.cos(a)});\nconst {${Object.keys(params).join(',')}} = _P;\n` + translatedCode;
      const fn = new Function('p', '_P', body);
      fn({x:0, y:0, z:0}, params); 
      setCompileErr(null);
      return fn;
    } catch (e) { 
      setCompileErr(e.message);
      return null; 
    }
  }, [code, params]);

  const mesh = useMemo(() => generateMesh(getP('PageWidth'), getP('PageHeight')), [getP('PageWidth'), getP('PageHeight')]);

  const project = (v, W, H) => {
    const {quat: q, dist, px, py} = cam;
    // Center X around page center, then rotate by inverse camera quaternion
    const x = v[0] - getP('PageWidth') * 0.5;
    const [rx, ry, rz] = quat.rotate(quat.conjugate(q), [x, v[1], v[2]]);
    const d = rz + dist;
    if (d < 5 || isNaN(rx) || isNaN(ry) || isNaN(rz)) return null; 
    const s = 450 / d;
    return [W/2 + rx*s + px, H/2 - ry*s + py, rz];
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shaderFn) return; 
    const ctx = canvas.getContext('2d');
    const {width: W, height: H} = canvas;
    ctx.clearRect(0,0,W,H);

    let activeRuntimeError = null;

    // Precompute visualizer params (needed for both mesh phase coloring and overlays)
    const A = getP('PeelAngleDegrees') * Math.PI / 180;
    const pdx = Math.cos(A), pdy = Math.sin(A);
    const progress = Math.max(Math.min(getP('FlipProgressAlpha'), 1), Math.min(getP('PeelIntensity'), 1));
    const sweep = getP('FoldTravelDistance') * progress;
    const oX = getP('PeelOriginX');
    const oY = getP('PeelOriginY');
    const arc1Len = (Math.PI/2) * getP('PrimaryBendRadius');
    const arc2Len = (Math.PI/2) * getP('SecondaryBendRadius');
    const twistBiasParam = getP('TwistAmount');

    // 1. Draw Mesh
    if (vis.mesh) {
        // Compute world + bend-phase distance per vertex
        const worldData = mesh.verts.map(v => {
          try {
            const off = shaderFn({x: v[0], y: v[1], z: v[2]}, params);
            if (isNaN(off.x) || isNaN(off.y) || isNaN(off.z)) throw new Error("Shader returning NaN values");
            // Compute d (distance past fold line) for bend-phase coloring
            const d = (oX - v[0]) * pdx + (oY - v[1]) * pdy + sweep + twistBiasParam * v[1];
            return {w: [v[0] + off.x, v[1] + off.y, v[2] + off.z], d};
          } catch(e) { 
            activeRuntimeError = e.message;
            return {w: v, d: -999};
          }
        });
        setRuntimeErr(activeRuntimeError);

        const world = worldData.map(d => d.w);
        const screen = world.map(v => project(v, W, H));
        const validFaces = mesh.faces.filter(f => screen[f[0]] && screen[f[1]] && screen[f[2]]);
        
        validFaces.map((f) => ({f, z: (screen[f[0]][2]+screen[f[1]][2]+screen[f[2]][2])/3}))
          .sort((a,b) => b.z - a.z).forEach(({f}) => {
            const p0=world[f[0]], p1=world[f[1]], p2=world[f[2]];
            const nx=(p1[1]-p0[1])*(p2[2]-p0[2])-(p1[2]-p0[2])*(p2[1]-p0[1]);
            const ny=(p1[2]-p0[2])*(p2[0]-p0[0])-(p1[0]-p0[0])*(p2[2]-p0[2]);
            const nz=(p1[0]-p0[0])*(p2[1]-p0[1])-(p1[1]-p0[1])*(p2[0]-p0[0]);
            const dot = Math.max(0, (nx*0.3 + ny*0.8 + nz*0.5)/(Math.sqrt(nx*nx+ny*ny+nz*nz)||1));
            
            ctx.beginPath();
            ctx.moveTo(screen[f[0]][0], screen[f[0]][1]);
            ctx.lineTo(screen[f[1]][0], screen[f[1]][1]);
            ctx.lineTo(screen[f[2]][0], screen[f[2]][1]);
            ctx.closePath();

            const faceForward = (screen[f[1]][0]-screen[f[0]][0])*(screen[f[2]][1]-screen[f[0]][1]) - (screen[f[1]][1]-screen[f[0]][1])*(screen[f[2]][0]-screen[f[0]][0]) < 0;
            let br = 0.3 + 0.7 * dot;

            // Bend-phase coloring (applied on top of lighting)
            if (vis.displacement) {
                const avgD = (worldData[f[0]].d + worldData[f[1]].d + worldData[f[2]].d) / 3;
                let phaseColor;
                if (avgD > 0 && avgD <= arc1Len)      phaseColor = [80, 220, 80];   // green
                else if (avgD <= arc1Len + arc2Len)   phaseColor = [60, 140, 240];  // blue
                else if (avgD > arc1Len + arc2Len)   phaseColor = [220, 220, 255];  // white-blue
                else                                  phaseColor = [160, 170, 190];  // gray (flat)
                ctx.fillStyle = faceForward
                    ? `rgba(${phaseColor[0]*br|0},${phaseColor[1]*br|0},${phaseColor[2]*br|0},0.85)`
                    : `rgba(${phaseColor[0]*br*0.6|0},${phaseColor[1]*br*0.6|0},${phaseColor[2]*br*0.6|0},0.85)`;
            } else {
                ctx.fillStyle = faceForward ? `rgba(${100*br},${140*br},${200*br},0.9)` : `rgba(${200*br},${160*br},${100*br},0.9)`;
            }
            ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.stroke();
        });
    }

    // --- VISUALIZER: ORIGIN & ANGLE ---
    if (vis.origin) {
        const originSc = project([oX, oY, 0], W, H);
        
        // Crosshair lines from page edges to origin
        const pageHW = getP('PageWidth') / 2;
        const pageHH = getP('PageHeight') / 2;
        const xTop = project([oX, pageHH, 0], W, H);
        const xBot = project([oX, -pageHH, 0], W, H);
        const yLef = project([-pageHW, oY, 0], W, H);
        const yRig = project([pageHW, oY, 0], W, H);
        ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(239,68,68,0.35)';
        if (xTop && xBot) { ctx.beginPath(); ctx.moveTo(xTop[0],xTop[1]); ctx.lineTo(xBot[0],xBot[1]); ctx.stroke(); }
        if (yLef && yRig) { ctx.beginPath(); ctx.moveTo(yLef[0],yLef[1]); ctx.lineTo(yRig[0],yRig[1]); ctx.stroke(); }
        ctx.setLineDash([]);

        // Origin dot
        if (originSc) {
            ctx.beginPath(); ctx.arc(originSc[0], originSc[1], 5, 0, Math.PI*2);
            ctx.fillStyle = '#ef4444'; ctx.fill();
            // Coords label
            const lbl = project([oX + 8, oY + 8, 0], W, H);
            if (lbl) { ctx.fillStyle = '#ef4444'; ctx.font = '9px monospace'; ctx.fillText(`(${oX},${oY})`, lbl[0], lbl[1]); }
        }

        // Direction arrow from origin
        const dirSc = project([oX + pdx*50, oY + pdy*50, 0], W, H);
        if (originSc && dirSc) {
            ctx.beginPath(); ctx.moveTo(originSc[0], originSc[1]); ctx.lineTo(dirSc[0], dirSc[1]);
            ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.stroke();
            const hdL = project([oX + pdx*35 - pdy*8, oY + pdy*35 + pdx*8, 0], W, H);
            const hdR = project([oX + pdx*35 + pdy*8, oY + pdy*35 - pdx*8, 0], W, H);
            if(hdL && hdR) {
                ctx.beginPath(); ctx.moveTo(dirSc[0], dirSc[1]);
                ctx.lineTo(hdL[0], hdL[1]); ctx.lineTo(hdR[0], hdR[1]);
                ctx.fillStyle = '#ef4444'; ctx.fill();
            }
        }
    }

    // --- VISUALIZER: CREASE LINE ---
    if (vis.crease) {
        const cx = oX + pdx * sweep;
        const cy = oY + pdy * sweep;
        const cr1 = project([cx - pdy*150, cy + pdx*150, 0], W, H);
        const cr2 = project([cx + pdy*150, cy - pdx*150, 0], W, H);
        if (cr1 && cr2) {
            ctx.beginPath(); ctx.moveTo(cr1[0], cr1[1]); ctx.lineTo(cr2[0], cr2[1]);
            ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 2; ctx.setLineDash([6,6]); ctx.stroke(); ctx.setLineDash([]);
        }
    }

    // --- VISUALIZER: BEND ARCS PROFILE ---
    if (vis.profileArcs) {
        // Collect all profile points
        const pts = [];
        for(let t = -50; t <= 150; t += 2) {
            const flatX = oX + pdx * t;
            const flatY = oY + pdy * t;
            try {
                const off = shaderFn({x: flatX, y: flatY, z: 0}, params);
                if(isNaN(off.x)) continue; 
                const scr = project([flatX + off.x, flatY + off.y, off.z + 1.5], W, H);
                if (scr) pts.push({t, scr});
            } catch(e) {}
        }
        const arc1 = (Math.PI/2) * getP('PrimaryBendRadius');
        const arc2 = (Math.PI/2) * getP('SecondaryBendRadius');
        const R1 = getP('PrimaryBendRadius');
        const R2 = getP('SecondaryBendRadius');
        const s2 = -getP('SecondaryCurlDirection');
        const VB = getP('VerticalBendSign');
        const foldX = oX + pdx * sweep;
        const foldY = oY + pdy * sweep;

        // --- PROFILE PATH TUBE (ghost, shows actual deformation) ---
        for (let pass = 0; pass < 3; pass++) {
            const w = pass === 0 ? 18 : pass === 1 ? 10 : 2;
            const a = pass === 0 ? 0.08 : pass === 1 ? 0.15 : 0.4;
            ctx.globalAlpha = a; ctx.lineWidth = w;
            for (let i = 1; i < pts.length; i++) {
                const dist = Math.max(0, pts[i].t - sweep);
                let c = '#22c55e';
                if (dist > arc1) c = '#3b82f6';
                if (dist > arc1 + arc2) c = '#ffffff';
                if (pass === 1) {
                    const r = parseInt(c.slice(1,3),16);
                    const g = parseInt(c.slice(3,5),16);
                    const b = parseInt(c.slice(5,7),16);
                    c = `rgb(${Math.min(255,r*1.4)},${Math.min(255,g*1.4)},${Math.min(255,b*1.4)})`;
                }
                ctx.beginPath(); ctx.moveTo(pts[i-1].scr[0], pts[i-1].scr[1]); ctx.lineTo(pts[i].scr[0], pts[i].scr[1]);
                ctx.strokeStyle = c; ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        // --- CYLINDER GUIDE: multiple arc rings along the fold axis ---
        const perpX = -pdy, perpY = pdx; // perpendicular to pullDir = fold line axis
        const cylinderRings = (radius, color, isSecondary = false) => {
            const numRings = 7;
            const halfSpan = getP('PageHeight') * 0.35;
            const pts3d = [];
            for (let ri = 0; ri < numRings; ri++) {
                const u = -halfSpan + (ri / (numRings - 1)) * halfSpan * 2;
                const ring = [];
                for (let a = 0; a <= Math.PI/2; a += 0.06) {
                    let px, py, pz;
                    if (isSecondary) {
                        const cx = R1 + s2 * R2;
                        px = foldX + perpX * u + pdx * (cx - s2 * R2 * Math.cos(a));
                        py = foldY + perpY * u + pdy * (cx - s2 * R2 * Math.cos(a));
                        pz = (R1 + R2 * Math.sin(a)) * VB;
                    } else {
                        px = foldX + perpX * u + pdx * R1 * Math.sin(a);
                        py = foldY + perpY * u + pdy * R1 * Math.sin(a);
                        pz = R1 * (1 - Math.cos(a)) * VB;
                    }
                    const scr = project([px, py, pz], W, H);
                    if (scr) ring.push(scr);
                }
                if (ring.length > 1) pts3d.push(ring);
            }

            // Draw rings as 3-pass tubes (outer glow → highlight → core)
            for (let pass = 0; pass < 3; pass++) {
                const w = [14, 8, 2.5][pass];
                const al = [0.15, 0.3, 0.85][pass];
                ctx.globalAlpha = al; ctx.lineWidth = w;
                for (const ring of pts3d) {
                    for (let i = 1; i < ring.length; i++) {
                        let c = color;
                        if (pass === 1) {
                            const r = parseInt(c.slice(1,3),16);
                            const g = parseInt(c.slice(3,5),16);
                            const b = parseInt(c.slice(5,7),16);
                            c = `rgb(${Math.min(255,r*1.3)},${Math.min(255,g*1.3)},${Math.min(255,b*1.3)})`;
                        }
                        ctx.beginPath(); ctx.moveTo(ring[i-1][0], ring[i-1][1]); ctx.lineTo(ring[i][0], ring[i][1]);
                        ctx.strokeStyle = c; ctx.stroke();
                    }
                }
            }
            ctx.globalAlpha = 1;

            // Draw longitudinal connecting lines (cylinder surface wires)
            ctx.lineWidth = 1; ctx.globalAlpha = 0.2; ctx.strokeStyle = color;
            for (let ai = 0; ai < pts3d[0].length; ai += 3) {
                for (let ri = 1; ri < pts3d.length; ri++) {
                    if (ai < pts3d[ri-1].length && ai < pts3d[ri].length) {
                        ctx.beginPath(); ctx.moveTo(pts3d[ri-1][ai][0], pts3d[ri-1][ai][1]);
                        ctx.lineTo(pts3d[ri][ai][0], pts3d[ri][ai][1]); ctx.stroke();
                    }
                }
            }
            ctx.globalAlpha = 1;
        };

        // Draw primary cylinder (green) and secondary cylinder (blue)
        cylinderRings(R1, '#22c55e', false);
        cylinderRings(R2, '#3b82f6', true);

        // --- Transition markers + labels ---
        const tFlatEnd = sweep, tPrimEnd = sweep + arc1, tSecEnd = sweep + arc1 + arc2;
        let pB, sB, tB, primMid, secMid;
        for (const pt of pts) {
            const d = pt.t;
            if (!pB && d >= tFlatEnd) pB = pt;
            if (!sB && d >= tPrimEnd) sB = pt;
            if (!tB && d >= tSecEnd)  tB = pt;
            if (!primMid && d >= tFlatEnd + arc1/2) primMid = pt;
            if (!secMid && d >= tPrimEnd + arc2/2)  secMid = pt;
        }
        ctx.setLineDash([3,3]); ctx.lineWidth = 1.2;
        const db = (pt, clr) => {
            if (!pt) return;
            const [bx,by] = pt.scr;
            ctx.beginPath(); ctx.moveTo(bx-6,by-6); ctx.lineTo(bx+6,by+6); ctx.strokeStyle=clr; ctx.stroke();
            ctx.beginPath(); ctx.moveTo(bx+6,by-6); ctx.lineTo(bx-6,by+6); ctx.strokeStyle=clr; ctx.stroke();
        };
        db(pB,'#22c55e'); db(sB,'#3b82f6'); db(tB,'#ffffff');
        ctx.setLineDash([]);
        ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
        if (primMid) { const [x,y]=primMid.scr; ctx.fillStyle='#22c55e'; ctx.fillText(`R₁=${R1.toFixed(1)}`,x+6,y+3); }
        if (secMid) { const [x,y]=secMid.scr; ctx.fillStyle='#3b82f6'; ctx.fillText(`R₂=${R2.toFixed(1)}`,x+6,y+3); }
        ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
        if (primMid) { const [x,y]=primMid.scr; ctx.fillStyle='#22c55e'; ctx.fillText(`R₁=${R1.toFixed(1)}`,x+6,y+3); }
        if (secMid) { const [x,y]=secMid.scr; ctx.fillStyle='#3b82f6'; ctx.fillText(`R₂=${R2.toFixed(1)}`,x+6,y+3); }
    }
  }, [mesh, cam, params, shaderFn, vis]);

  useEffect(() => { draw(); }, [draw]);

  const toggleVis = (key) => setVis(v => ({...v, [key]: !v[key]}));
  const setP = (k, v) => setParams(p => ({...p, [k]: v}));
  
  const setDist = (v) => {
      const d = parseFloat(v);
      if(!isNaN(d)) setCam(c => ({...c, dist: Math.max(50, Math.min(1200, d))}));
  };

  // --- COMPASS GIZMO DRAWING ---
  useEffect(() => {
    const canvas = compassRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const S = 150, C = S/2, R = 55;
    ctx.clearRect(0,0,S,S);

    // Background ring
    ctx.beginPath(); ctx.arc(C,C,R+16,0,Math.PI*2);
    ctx.fillStyle = 'rgba(13,17,23,0.88)'; ctx.fill();
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1; ctx.stroke();

    // Axis directions in view space (conjugate rotates world->view)
    const qConj = quat.conjugate(cam.quat);
    const axLen = 38;
    const axes = [
      {dir: quat.rotate(qConj, [1,0,0]), color: '#ff4444', label: 'X'},
      {dir: quat.rotate(qConj, [0,1,0]), color: '#44ff44', label: 'Y'},
      {dir: quat.rotate(qConj, [0,0,1]), color: '#3399ff', label: 'Z'},
    ];

    for (const {dir, color, label} of axes) {
      const ex = C + dir[0]*axLen;
      const ey = C - dir[1]*axLen; // flip Y for screen coords
      // Depth cue: dim if pointing away from camera
      const depth = 0.35 + 0.65 * Math.max(0, dir[2] * 0.5 + 0.5);

      // Line
      ctx.beginPath(); ctx.moveTo(C,C); ctx.lineTo(ex, ey);
      ctx.strokeStyle = color; ctx.globalAlpha = depth; ctx.lineWidth = 2.5;
      ctx.stroke(); ctx.globalAlpha = 1;

      // Cone tip
      const tipR = 7;
      const tx = dir[0] * (axLen + 2);
      const ty = dir[1] * (axLen + 2);
      ctx.beginPath(); ctx.arc(C+tx, C-ty, tipR, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.globalAlpha = depth; ctx.fill(); ctx.globalAlpha = 1;

      // Label
      ctx.fillStyle = color; ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lx = dir[0] * (axLen + 14);
      const ly = dir[1] * (axLen + 14);
      ctx.globalAlpha = Math.max(0.3, depth);
      ctx.fillText(label, C+lx, C-ly);
      ctx.globalAlpha = 1;
    }

    // 90° arrow buttons at cardinal points
    const btnR = 11;
    const btnD = R + 8;
    const btns = [
      {angle: -Math.PI/2, symbol: '▲'},
      {angle: 0,          symbol: '▶'},
      {angle: Math.PI/2,  symbol: '▼'},
      {angle: Math.PI,    symbol: '◀'},
    ];
    for (const {angle, symbol} of btns) {
      const bx = C + Math.cos(angle)*btnD;
      const by = C + Math.sin(angle)*btnD;
      ctx.beginPath(); ctx.arc(bx, by, btnR, 0, Math.PI*2);
      ctx.fillStyle = '#21262d'; ctx.fill();
      ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#8b949e'; ctx.font = '10px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(symbol, bx, by+1);
    }
  }, [cam.quat]);

  // --- COMPASS MOUSE HANDLERS ---
  const compassBtnR = 11;
  const compassBtnD = 55 + 8; // same as in drawing
  const compassAxLen = 38;

  const rotate90 = (axis, angle) => {
    setCam(c => ({...c, quat: quat.multiply(quat.fromAxisAngle(axis, angle), c.quat)}));
  };

  const handleCompassDown = (e) => {
    const rect = compassRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const C = 75; // center of 150px canvas

    // Check arrow buttons first
    const dirs = [
      {angle: -Math.PI/2, axis: [1,0,0], deg: -Math.PI/2}, // up → pitch up
      {angle: 0,          axis: [0,1,0], deg: -Math.PI/2}, // right → yaw right
      {angle: Math.PI/2,  axis: [1,0,0], deg: Math.PI/2},  // down → pitch down
      {angle: Math.PI,    axis: [0,1,0], deg: Math.PI/2},  // left → yaw left
    ];
    for (const {angle, axis, deg} of dirs) {
      const bx = C + Math.cos(angle)*compassBtnD;
      const by = C + Math.sin(angle)*compassBtnD;
      if (Math.hypot(x-bx, y-by) < compassBtnR) {
        rotate90(axis, deg);
        return;
      }
    }

    // Start compass drag for orbit
    compassDragRef.current = {x: e.clientX, y: e.clientY};
  };

  const handleCompassMove = (e) => {
    if (!compassDragRef.current) return;
    const dx = (e.clientX - compassDragRef.current.x) * 0.008;
    const dy = (e.clientY - compassDragRef.current.y) * 0.008;
    const angle = Math.hypot(dx, dy);
    if (angle > 0.001) {
      const axis = [-dy/angle, dx/angle, 0];
      const deltaQ = quat.fromAxisAngle(axis, angle);
      setCam(c => ({...c, quat: quat.multiply(deltaQ, c.quat)}));
    }
    compassDragRef.current = {x: e.clientX, y: e.clientY};
  };

  const handleCompassUp = () => { compassDragRef.current = null; };

  // Compute display angles from quaternion (for the camera info overlay)
  const viewDir = useMemo(() => quat.rotate(cam.quat, [0, 0, 1]), [cam.quat]);
  const displayYaw = Math.atan2(viewDir[0], viewDir[2]);
  const displayPitch = Math.asin(Math.max(-1, Math.min(1, viewDir[1])));

  const activeParams = Object.keys(PARAMS_DICT).filter(k => code.includes(k) || k === 'PageWidth' || k === 'PageHeight');

  return (
    <div style={{display:'flex', height:'100vh', background:'#0d1117', color:'#cdd9e5', fontFamily:'monospace', overflow:'hidden'}}>
      <div style={{flex: 1, position:'relative', borderRight:'1px solid #30363d'}}>
        <canvas ref={canvasRef} width={800} height={800} 
          onMouseDown={e => dragRef.current = {x:e.clientX, y:e.clientY}}
          onMouseMove={e => { if(!dragRef.current) return;
            const dx=(e.clientX-dragRef.current.x)*0.008;
            const dy=(e.clientY-dragRef.current.y)*0.008;
            const angle = Math.sqrt(dx*dx + dy*dy);
            if (angle > 0.001) {
                const axis = [-dy/angle, dx/angle, 0]; // Perpendicular to drag in screen space
                const deltaQ = quat.fromAxisAngle(axis, angle);
                setCam(c => ({...c, quat: quat.multiply(deltaQ, c.quat)}));
            }
            dragRef.current = {x:e.clientX, y:e.clientY};
          }} 
          onMouseUp={()=>dragRef.current=null}
          onMouseLeave={()=>dragRef.current=null}
          onWheel={e => setCam(c => ({...c, dist: Math.max(50, Math.min(1200, c.dist + e.deltaY * 0.5))}))}
          style={{width:'100%', height:'100%', cursor:'grab'}} />
        
        <div style={{position:'absolute', top:20, left:20, display:'flex', gap:6}}>
            <button onClick={()=>setCam(c=>({...c, quat: quat.identity()}))} style={btnStyle}>FRONT</button>
            <button onClick={()=>setCam(c=>({...c, quat: quat.fromAxisAngle([0,1,0], -1.57)}))} style={btnStyle}>SIDE</button>
            <button onClick={()=>setCam(c=>({...c, quat: quat.fromAxisAngle([1,0,0], -1.57)}))} style={btnStyle}>TOP</button>
            <button onClick={()=>setCam(defaultCam)} style={{...btnStyle, color:'#f78166'}}>RESET</button>
        </div>

        {/* CAMERA OVERLAY */}
        <div style={{position:'absolute', bottom:20, left:20, fontSize:10, color:'#8b949e', background:'rgba(0,0,0,0.8)', padding:10, borderRadius:5, display:'flex', gap:10, alignItems:'center'}}>
            <label>DIST <input type="number" step="10" value={Number(cam.dist).toFixed(0)} onChange={e=>setDist(e.target.value)} style={inputStyle} /></label>
            <span style={{color:'#56595e'}}> 🔄 drag to orbit</span>
        </div>

        {/* COMPACT VISUALIZER TOGGLE + CAMERA INFO */}
        <div style={{position:'absolute', bottom:175, right:20, fontSize:9, color:'#8b949e', background:'rgba(0,0,0,0.85)', padding:'6px 8px', borderRadius:5, display:'flex', flexDirection:'column', gap:3}}>
          <div style={{display:'flex', gap:5, alignItems:'center'}}>
            <span style={{color:'#56595e', fontSize:8, marginRight:2}}>VIEW:</span>
            {['mesh','origin','crease','profileArcs','displacement'].map(k => (
              <label key={k} style={{display:'flex', alignItems:'center', gap:2, cursor:'pointer', color:vis[k]?'#c9d1d9':'#56595e', fontSize:9}}>
                <input type="checkbox" checked={vis[k]} onChange={()=>toggleVis(k)} style={{margin:0, width:9, height:9}} />
                <span>
                  {k === 'profileArcs' ? 'arcs' : k === 'crease' ? 'fold' : k === 'displacement' ? 'phase' : k}
                </span>
              </label>
            ))}
          </div>
          <div style={{display:'flex', gap:6, color:'#56595e', fontSize:8}}>
            <span>YAW <span style={{color:'#79c0ff'}}>{displayYaw.toFixed(2)}</span></span>
            <span>PITCH <span style={{color:'#79c0ff'}}>{displayPitch.toFixed(2)}</span></span>
            <span>DIST <span style={{color:'#79c0ff'}}>{cam.dist.toFixed(0)}</span></span>
          </div>
        </div>

        {/* COMPASS GIZMO */}
        <div style={{position:'absolute', bottom:20, right:20}}>
          <canvas ref={compassRef} width={150} height={150}
            onMouseDown={handleCompassDown}
            onMouseMove={handleCompassMove}
            onMouseUp={handleCompassUp}
            onMouseLeave={handleCompassUp}
            style={{cursor:'pointer', display:'block'}} />
        </div>
      </div>

      <div style={{width: 450, overflowY:'auto', background:'#010409', display:'flex', flexDirection:'column'}}>
        
        <div style={{padding:20, borderBottom:'1px solid #30363d', position:'relative'}}>
            <h4 style={{margin:'0 0 10px 0', color:'#f78166'}}>UE5 HLSL SHADER LAB</h4>
            <div style={{fontSize:9, color:'#8b949e', marginBottom:10}}>* Type a parameter name (e.g. 'TwistAmount') to spawn its slider!</div>
            <textarea value={code} onChange={e=>setCode(e.target.value)} spellCheck="false"
                style={{width:'100%', height:320, background:'#0d1117', color:'#79c0ff', border:`1px solid ${compileErr || runtimeErr ? '#f85149' : '#30363d'}`, padding:10, fontSize:11, lineHeight:'1.5', whiteSpace:'pre'}} />
            {(compileErr || runtimeErr) && (
                <div style={{color:'#f85149', fontSize:10, marginTop:5, padding:5, background:'#3a1d1d', borderRadius:3}}>
                    ERROR: {compileErr || runtimeErr}
                </div>
            )}
        </div>

        <div style={{padding:20, borderBottom:'1px solid #30363d', background:'#090d13'}}>
            <h4 style={{margin:'0 0 10px 0', color:'#a5d6ff'}}>VISUALIZERS</h4>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                <label style={checkStyle}><input type="checkbox" checked={vis.mesh} onChange={()=>toggleVis('mesh')} /> Page Mesh</label>
                <label style={checkStyle}><input type="checkbox" checked={vis.origin} onChange={()=>toggleVis('origin')} /> <span style={{color:'#ef4444'}}>■</span> Origin & Angle</label>
                <label style={checkStyle}><input type="checkbox" checked={vis.crease} onChange={()=>toggleVis('crease')} /> <span style={{color:'#ffcc00'}}>■</span> Crease Line</label>
                <label style={checkStyle}><input type="checkbox" checked={vis.profileArcs} onChange={()=>toggleVis('profileArcs')} /> <span style={{color:'#22c55e'}}>■</span> Bend Arcs</label>
                <label style={checkStyle}><input type="checkbox" checked={vis.displacement} onChange={()=>toggleVis('displacement')} /> <span style={{color:'#79c0ff'}}>◈</span> Bend Phase</label>
            </div>
        </div>

        <div style={{padding:20}}>
            <h4 style={{margin:'0 0 10px 0', color:'#c9d1d9'}}>ACTIVE PARAMETERS</h4>
            <div style={{display:'grid', gap:12}}>
                {activeParams.map(k => (
                    <Param key={k} label={k} val={params[k]} min={PARAMS_DICT[k].min} max={PARAMS_DICT[k].max} step={PARAMS_DICT[k].step} onChange={v => setP(k, v)} />
                ))}
            </div>
        </div>
      </div>
    </div>
  );
}

function Param({label, val, min, max, step=1, onChange}) {
    return (
      <div style={{fontSize:11}}>
        <div style={{display:'flex', justifyContent:'space-between', marginBottom:4}}>
          <span>{label}</span>
          <input type="number" step={step} value={val}
            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
            style={{width:60, background:'#0d1117', border:'1px solid #30363d', color:'#79c0ff', padding:'2px 5px', fontSize:10, textAlign:'right'}} />
        </div>
        <input type="range" min={min} max={max} step={step} value={val}
          onChange={e => onChange(parseFloat(e.target.value))} style={{width:'100%'}} />
      </div>
    );
}
const btnStyle = { background:'#21262d', border:'1px solid #30363d', color:'#c9d1d9', padding:'4px 10px', fontSize:10, borderRadius:4, cursor:'pointer' };
const checkStyle = { fontSize:11, display:'flex', alignItems:'center', gap:5, cursor:'pointer', color:'#c9d1d9' };
const inputStyle = { width: 50, background: '#0d1117', border: '1px solid #30363d', color: '#79c0ff', padding: '2px 5px', fontSize: 10, marginLeft: 5 };