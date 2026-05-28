import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

// --- HLSL SHIM PREAMBLE ---
// This allows the editor to use HLSL-like syntax
const PREAMBLE = `
const sin=Math.sin, cos=Math.cos, tan=Math.tan, abs=Math.abs, 
      max=Math.max, min=Math.min, sqrt=Math.sqrt, pow=Math.pow,
      floor=Math.floor, ceil=Math.ceil, exp=Math.exp, log=Math.log,
      atan2=Math.atan2, PI=Math.PI, HALF_PI=Math.PI*0.5;
const saturate = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const radians = (d) => d * PI / 180;
const dot = (a, b) => (a.x*b.x + a.y*b.y + (a.z||0)*(b.z||0));
const length = (a) => Math.sqrt(a.x*a.x + a.y*a.y + (a.z*a.z||0));
const normalize = (a) => {
  const l = length(a) || 1;
  return {x: a.x/l, y: a.y/l, z: (a.z||0)/l};
};
const float2 = (x, y) => ({x, y});
const float3 = (x, y, z) => ({x, y, z});
const sincos = (a) => ({s: Math.sin(a), c: Math.cos(a)});
`;

const DEFAULT_SHADER = `// 'p' = VertexLocalPos (float3)
// All parameters below are available as direct variables.

const progress = max(saturate(FlipAlpha), saturate(PeelIntensity));

// 1. Setup Rotation & Direction
const rotRad = FlipAlpha * PI;
const {s: sR, c: cR} = sincos(rotRad);
const midAir = sin(rotRad);

const {s: sA, c: cA} = sincos(radians(PeelAngle));
const pullDir = float2(cA, sA);

// 2. Fold Math
const sweep = FoldTravel * progress;
const d = dot(float2(PeelOriginX - p.x, PeelOriginY - p.y), pullDir) + sweep;

let bent = float3(p.x, p.y, p.z);
const foldMask = smoothstep(0.0, 4.0, d);
const dist = max(0.0, d);

// 3. Dual Arc Bend (Primary & Secondary)
let zO = 0.0, xO = 0.0;
const arc1 = HALF_PI * PrimaryRadius;
const arc2 = HALF_PI * SecondaryRadius;

if (dist < arc1) {
    const {s, c} = sincos(dist / PrimaryRadius);
    zO = PrimaryRadius * (1.0 - c);
    xO = dist - PrimaryRadius * s;
} else if (dist < arc1 + arc2) {
    const {s, c} = sincos((dist - arc1) / SecondaryRadius);
    const s2 = -SecondaryCurlDir;
    zO = PrimaryRadius + SecondaryRadius * s;
    xO = dist - (PrimaryRadius + s2 * SecondaryRadius - s2 * SecondaryRadius * c);
} else {
    const s2 = -SecondaryCurlDir;
    zO = PrimaryRadius + SecondaryRadius;
    xO = dist - (PrimaryRadius + s2 * SecondaryRadius + s2 * (dist - arc1 - arc2));
}

bent.z += zO * foldMask * BendSign;
bent.x += pullDir.x * xO * foldMask;
bent.y += pullDir.y * xO * foldMask;

// 4. Final Hinge Rotation (The 180 flip)
const finalX = bent.x * cR - bent.z * sR;
const finalY = bent.y;
const finalZ = bent.x * sR + bent.z * cR;

return float3(finalX - p.x, finalY - p.y, finalZ - p.z);`;

const DEFAULT_PARAMS = {
  FlipAlpha: 0.2, PeelIntensity: 0,
  PeelAngle: 180, FoldTravel: 40,
  PrimaryRadius: 10, SecondaryRadius: 15,
  PeelOriginX: 100, PeelOriginY: 0,
  BendSign: 1, SecondaryCurlDir: 1,
  PageWidth: 100, PageHeight: 140,
};

// --- Utilities ---
function generateMesh(w, h, cols=20, rows=15) {
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

export default function PageBendApp() {
  const [code, setCode] = useState(DEFAULT_SHADER);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [cam, setCam] = useState({ yaw: -0.4, pitch: 0.3, dist: 400, px: 0, py: 0 });
  const [showVisuals, setShowVisuals] = useState(true);
  const [compileErr, setCompileErr] = useState(null);
  const [runtimeErr, setRuntimeErr] = useState(null);
  
  const canvasRef = useRef();
  const dragRef = useRef(null);

  // Compile "Shader"
  const shaderFn = useMemo(() => {
    try {
      const body = PREAMBLE + `const {${Object.keys(params).join(',')}} = _P;\n` + code;
      const fn = new Function('p', '_P', body);
      // Test run
      fn({x:0, y:0, z:0}, params);
      setCompileErr(null);
      return fn;
    } catch (e) {
      setCompileErr(e.message);
      return null;
    }
  }, [code, params]);

  const mesh = useMemo(() => 
    generateMesh(params.PageWidth, params.PageHeight), 
    [params.PageWidth, params.PageHeight]
  );

  // Projection logic
  const project = (v, W, H) => {
    const {yaw, pitch, dist, px, py} = cam;
    const cy=Math.cos(yaw), sy=Math.sin(yaw), cp=Math.cos(pitch), sp=Math.sin(pitch);
    const x=v[0], y=v[1], z=v[2];
    const rx = x*cy + z*sy, rz0 = -x*sy + z*cy;
    const ry2 = y*cp - rz0*sp, rz2 = y*sp + rz0*cp;
    const d = rz2 + dist;
    const s = 350 / Math.max(d, 1);
    return [W/2 + rx*s + px, H/2 - ry2*s + py, rz2];
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shaderFn) return;
    const ctx = canvas.getContext('2d');
    const {width: W, height: H} = canvas;
    ctx.clearRect(0,0,W,H);

    // Compute vertices
    let rErr = null;
    const world = mesh.verts.map(v => {
      try {
        const offset = shaderFn({x: v[0], y: v[1], z: v[2]}, params);
        return [v[0] + offset.x, v[1] + offset.y, v[2] + offset.z];
      } catch(e) { rErr = e.message; return v; }
    });
    setRuntimeErr(rErr);

    const screen = world.map(v => project(v, W, H));
    
    // Depth Sort
    const sorted = mesh.faces
      .map((f, i) => ({f, z: (screen[f[0]][2]+screen[f[1]][2]+screen[f[2]][2])/3}))
      .sort((a,b) => b.z - a.z);

    // Render Mesh
    sorted.forEach(({f}) => {
      const p0=world[f[0]], p1=world[f[1]], p2=world[f[2]];
      const nx=(p1[1]-p0[1])*(p2[2]-p0[2])-(p1[2]-p0[2])*(p2[1]-p0[1]);
      const ny=(p1[2]-p0[2])*(p2[0]-p0[0])-(p1[0]-p0[0])*(p2[2]-p0[2]);
      const nz=(p1[0]-p0[0])*(p2[1]-p0[1])-(p1[1]-p0[1])*(p2[0]-p0[0]);
      const mag = Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
      const dot = Math.max(0, (nx*0.3 + ny*0.8 + nz*0.5)/mag);
      
      ctx.beginPath();
      ctx.moveTo(screen[f[0]][0], screen[f[0]][1]);
      ctx.lineTo(screen[f[1]][0], screen[f[1]][1]);
      ctx.lineTo(screen[f[2]][0], screen[f[2]][1]);
      ctx.closePath();

      const faceForward = (screen[f[1]][0]-screen[f[0]][0])*(screen[f[2]][1]-screen[f[0]][1]) - (screen[f[1]][1]-screen[f[0]][1])*(screen[f[2]][0]-screen[f[0]][0]) < 0;
      const baseCol = faceForward ? [100, 140, 200] : [200, 160, 100];
      const br = 0.3 + 0.7 * dot;
      ctx.fillStyle = `rgb(${baseCol[0]*br},${baseCol[1]*br},${baseCol[2]*br})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.1)';
      ctx.stroke();
    });

    // --- VISUALIZER OVERLAY ---
    if (showVisuals) {
      const angle = params.PeelAngle * Math.PI / 180;
      const origin = [params.PeelOriginX, params.PeelOriginY, 0];
      const dir = [Math.cos(angle), Math.sin(angle)];
      
      // Draw Fold Line
      const p1 = project([origin[0] - dir[1]*100, origin[1] + dir[0]*100, 0], W, H);
      const p2 = project([origin[0] + dir[1]*100, origin[1] - dir[0]*100, 0], W, H);
      ctx.setLineDash([5,5]); ctx.strokeStyle='#ffcc00'; ctx.beginPath();
      ctx.moveTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); ctx.stroke(); ctx.setLineDash([]);

      // Draw Radius Arcs Profile
      const drawArc = (r, startAngle, endAngle, color, label) => {
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 3;
        for (let a=startAngle; a<=endAngle; a+=0.1) {
            const lx = r * (1 - Math.cos(a));
            const lz = r * Math.sin(a);
            // Projecting a cross section at the origin
            const pt = project([origin[0] - dir[0]*lx, origin[1] - dir[1]*lx, lz * params.BendSign], W, H);
            if (a===startAngle) ctx.moveTo(pt[0], pt[1]); else ctx.lineTo(pt[0], pt[1]);
        }
        ctx.stroke();
      };
      drawArc(params.PrimaryRadius, 0, Math.PI/2, '#22c55e', 'R1');
      drawArc(params.SecondaryRadius, Math.PI/2, Math.PI, '#3b82f6', 'R2');
    }
  }, [mesh, cam, params, shaderFn, showVisuals]);

  useEffect(() => { draw(); }, [draw]);

  // Camera Presets
  const setQuickView = (view) => {
    if (view === 'front') setCam(c => ({...c, yaw: 0, pitch: 0}));
    if (view === 'top') setCam(c => ({...c, yaw: 0, pitch: 1.57}));
    if (view === 'side') setCam(c => ({...c, yaw: 1.57, pitch: 0}));
    if (view === 'under') setCam(c => ({...c, yaw: 0, pitch: -1.57}));
  };

  return (
    <div style={{display:'flex', height:'100vh', background:'#0d1117', color:'#cdd9e5', fontFamily:'monospace'}}>
      {/* Left Panel: Viewport */}
      <div style={{flex: 1, position:'relative', borderRight:'1px solid #30363d'}}>
        <canvas 
          ref={canvasRef} width={600} height={600} 
          onMouseDown={e => dragRef.current = {x:e.clientX, y:e.clientY, cam}}
          onMouseMove={e => {
            if (!dragRef.current) return;
            const dx = (e.clientX - dragRef.current.x)*0.01;
            const dy = (e.clientY - dragRef.current.y)*0.01;
            setCam(c => ({...c, yaw: dragRef.current.cam.yaw + dx, pitch: dragRef.current.cam.pitch + dy}));
          }}
          onMouseUp={() => dragRef.current = null}
          style={{width:'100%', height:'100%', cursor:'grab'}}
        />
        
        {/* Quick View Controls */}
        <div style={{position:'absolute', top:20, left:20, display:'flex', gap:5}}>
            {['front', 'top', 'side', 'under'].map(v => (
                <button key={v} onClick={() => setQuickView(v)} style={btnStyle}>{v.toUpperCase()}</button>
            ))}
            <button onClick={() => setShowVisuals(!showVisuals)} style={{...btnStyle, background: showVisuals ? '#238636' : '#30363d'}}>
               {showVisuals ? 'VISUALIZER: ON' : 'VISUALIZER: OFF'}
            </button>
        </div>

        <div style={{position:'absolute', bottom:20, left:20, fontSize:10, color:'#8b949e'}}>
            DRAG TO ROTATE • SCROLL TO ZOOM (COMING SOON) • ORANGE LINE = CREASE • GREEN/BLUE = RADII ARCS
        </div>
      </div>

      {/* Right Panel: Editor & Params */}
      <div style={{width: 450, display:'flex', flexDirection:'column', overflowY:'auto'}}>
        <div style={{padding:15, borderBottom:'1px solid #30363d'}}>
            <h4 style={{margin:'0 0 10px 0', color:'#f78166'}}>UE5 CUSTOM HLSL SHIM</h4>
            <textarea 
                value={code} 
                onChange={e => setCode(e.target.value)}
                style={{width:'100%', height:300, background:'#010409', color:'#79c0ff', border:'1px solid #30363d', padding:10, fontSize:12, fontFamily:'"Fira Code", monospace'}}
            />
            {compileErr && <div style={{color:'#f85149', fontSize:11, marginTop:5}}>Error: {compileErr}</div>}
        </div>

        <div style={{padding:15}}>
            <h4 style={{margin:'0 0 10px 0'}}>PARAMETERS</h4>
            <div style={{display:'grid', gap:10}}>
                <ParamSlider label="Flip Progress" val={params.FlipAlpha} min={0} max={1} step={0.01} onChange={v => setParams({...params, FlipAlpha: v})} />
                <ParamSlider label="Peel Angle" val={params.PeelAngle} min={0} max={360} step={1} onChange={v => setParams({...params, PeelAngle: v})} />
                <ParamSlider label="Primary Radius" val={params.PrimaryRadius} min={1} max={50} step={0.5} onChange={v => setParams({...params, PrimaryRadius: v})} />
                <ParamSlider label="Secondary Radius" val={params.SecondaryRadius} min={1} max={50} step={0.5} onChange={v => setParams({...params, SecondaryRadius: v})} />
                <hr style={{width:'100%', border:'0.5px solid #30363d'}}/>
                <ParamSlider label="Page Width" val={params.PageWidth} min={50} max={200} step={1} onChange={v => setParams({...params, PageWidth: v})} />
                <ParamSlider label="Page Height" val={params.PageHeight} min={50} max={250} step={1} onChange={v => setParams({...params, PageHeight: v})} />
                <ParamSlider label="Origin X" val={params.PeelOriginX} min={0} max={params.PageWidth} step={1} onChange={v => setParams({...params, PeelOriginX: v})} />
            </div>
        </div>
      </div>
    </div>
  );
}

function ParamSlider({label, val, min, max, step, onChange}) {
    return (
        <div style={{fontSize:11}}>
            <div style={{display:'flex', justifyContent:'space-between', marginBottom:3}}>
                <span>{label}</span>
                <span style={{color:'#79c0ff'}}>{val}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={val} onChange={e => onChange(parseFloat(e.target.value))} style={{width:'100%'}} />
        </div>
    );
}

const btnStyle = {
    background: '#21262d',
    border: '1px solid #30363d',
    color: '#c9d1d9',
    padding: '4px 8px',
    fontSize: '10px',
    borderRadius: '4px',
    cursor: 'pointer'
};