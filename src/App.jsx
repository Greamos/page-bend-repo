import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

// --- HLSL SHIM PREAMBLE ---
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
const float3 = (x, y, z) => ({x, y, z});
const float2 = (x, y) => ({x, y});
const sincos = (a) => ({s: Math.sin(a), c: Math.cos(a)});
`;

const DEFAULT_SHADER = `// 'p' = VertexLocalPos (float3)
const progress = max(saturate(FlipAlpha), saturate(PeelIntensity));
const rotRad = FlipAlpha * PI;
const {s: sR, c: cR} = sincos(rotRad);
const {s: sA, c: cA} = sincos(radians(PeelAngle));
const pullDir = float2(cA, sA);

const sweep = FoldTravel * progress;
const d = dot(float2(PeelOriginX - p.x, PeelOriginY - p.y), pullDir) + sweep;

let bent = float3(p.x, p.y, p.z);
const foldMask = smoothstep(0.0, 4.0, d);
const dist = max(0.0, d);

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

const finalX = bent.x * cR - bent.z * sR;
const finalY = bent.y;
const finalZ = bent.x * sR + bent.z * cR;

return float3(finalX - p.x, finalY - p.y, finalZ - p.z);`;

const DEFAULT_PARAMS = {
  FlipAlpha: 0.15, PeelIntensity: 0, PeelAngle: 180, FoldTravel: 40,
  PrimaryRadius: 10, SecondaryRadius: 15, PeelOriginX: 100, PeelOriginY: 0,
  BendSign: 1, SecondaryCurlDir: 1, PageWidth: 100, PageHeight: 140,
};

function generateMesh(w, h, cols=25, rows=20) {
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
  const [params, setParams] = useState(DEFAULT_PARAMS);
  
  // Dynamic Visualizer State
  const [vis, setVis] = useState({
      mesh: true,
      crease: true,
      primaryArc: true,
      secondaryArc: true
  });
  
  // Exact requested camera defaults
  const defaultCam = { yaw: -6.28, pitch: 4.26, dist: 212, px: 0, py: 0 };
  const [cam, setCam] = useState(defaultCam);
  
  const canvasRef = useRef();
  const dragRef = useRef(null);

  const shaderFn = useMemo(() => {
    try {
      const body = PREAMBLE + `const {${Object.keys(params).join(',')}} = _P;\n` + code;
      return new Function('p', '_P', body);
    } catch (e) { return null; }
  }, [code, params]);

  const mesh = useMemo(() => generateMesh(params.PageWidth, params.PageHeight), [params.PageWidth, params.PageHeight]);

  const project = (v, W, H) => {
    const {yaw, pitch, dist, px, py} = cam;
    const cy=Math.cos(yaw), sy=Math.sin(yaw), cp=Math.cos(pitch), sp=Math.sin(pitch);
    const x = v[0] - params.PageWidth * 0.5;
    const y = v[1];
    const z = v[2];
    const rx = x*cy + z*sy, rz0 = -x*sy + z*cy;
    const ry2 = y*cp - rz0*sp, rz2 = y*sp + rz0*cp;
    const s = 450 / Math.max(rz2 + dist, 1);
    return [W/2 + rx*s + px, H/2 - ry2*s + py, rz2];
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shaderFn) return;
    const ctx = canvas.getContext('2d');
    const {width: W, height: H} = canvas;
    ctx.clearRect(0,0,W,H);

    // 1. Draw Mesh
    if (vis.mesh) {
        const world = mesh.verts.map(v => {
          try {
            const off = shaderFn({x: v[0], y: v[1], z: v[2]}, params);
            return [v[0] + off.x, v[1] + off.y, v[2] + off.z];
          } catch(e) { return v; }
        });

        const screen = world.map(v => project(v, W, H));
        mesh.faces.map((f, i) => ({f, z: (screen[f[0]][2]+screen[f[1]][2]+screen[f[2]][2])/3}))
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
            const br = 0.3 + 0.7 * dot;
            ctx.fillStyle = faceForward ? `rgba(${100*br},${140*br},${200*br},0.9)` : `rgba(${200*br},${160*br},${100*br},0.9)`;
            ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.1)';
            ctx.stroke();
        });
    }

    // 2. Dynamic Math Visualizer
    // This feeds a line of virtual points into the HLSL shader to visualize the arcs
    const A = params.PeelAngle * Math.PI / 180;
    const pdx = Math.cos(A), pdy = Math.sin(A);
    const progress = Math.max(Math.min(params.FlipAlpha, 1), Math.min(params.PeelIntensity, 1));
    const sweep = params.FoldTravel * progress;
    
    let lastPt = null;
    ctx.lineWidth = 4;

    for(let t = -50; t <= 100; t += 2) {
        // Flat point along the pull direction starting at origin
        const flatX = params.PeelOriginX - pdx * t;
        const flatY = params.PeelOriginY - pdy * t;
        
        try {
            // Push point through custom HLSL
            const off = shaderFn({x: flatX, y: flatY, z: 0}, params);
            const wx = flatX + off.x, wy = flatY + off.y, wz = off.z;
            const scr = project([wx, wy, wz], W, H);
            
            if (lastPt) {
                const dist = Math.max(0, t + sweep);
                const arc1 = (Math.PI/2) * params.PrimaryRadius;
                const arc2 = (Math.PI/2) * params.SecondaryRadius;
                
                let color = null;
                
                if (t + sweep <= 0 && vis.crease) {
                    color = '#ffcc00'; // Crease (Flat area)
                    ctx.setLineDash([4,4]);
                } else if (dist > 0 && dist <= arc1 && vis.primaryArc) {
                    color = '#22c55e'; // Primary Radius (Green)
                    ctx.setLineDash([]);
                } else if (dist > arc1 && dist <= arc1 + arc2 && vis.secondaryArc) {
                    color = '#3b82f6'; // Secondary Radius (Blue)
                    ctx.setLineDash([]);
                } else if (dist > arc1 + arc2 && vis.secondaryArc) {
                    color = '#ffffff'; // Tail end
                    ctx.setLineDash([]);
                }
                
                if (color) {
                    ctx.beginPath();
                    ctx.moveTo(lastPt[0], lastPt[1]);
                    ctx.lineTo(scr[0], scr[1]);
                    ctx.strokeStyle = color;
                    ctx.stroke();
                }
            }
            lastPt = scr;
        } catch(e) {}
    }
    ctx.setLineDash([]);
    
  }, [mesh, cam, params, shaderFn, vis]);

  useEffect(() => { draw(); }, [draw]);

  const toggleVis = (key) => setVis(v => ({...v, [key]: !v[key]}));

  return (
    <div style={{display:'flex', height:'100vh', background:'#0d1117', color:'#cdd9e5', fontFamily:'monospace', overflow:'hidden'}}>
      <div style={{flex: 1, position:'relative', borderRight:'1px solid #30363d'}}>
        <canvas ref={canvasRef} width={800} height={800} 
          onMouseDown={e => dragRef.current = {x:e.clientX, y:e.clientY, cam}}
          onMouseMove={e => { if(!dragRef.current) return;
            const dx=(e.clientX-dragRef.current.x)*0.01, dy=(e.clientY-dragRef.current.y)*0.01;
            setCam(c=>({...c, yaw: dragRef.current.cam.yaw+dx, pitch: dragRef.current.cam.pitch+dy}));
          }} 
          onMouseUp={()=>dragRef.current=null}
          onWheel={e => setCam(c => ({...c, dist: Math.max(10, Math.min(1200, c.dist + e.deltaY * 0.5))}))}
          style={{width:'100%', height:'100%', cursor:'grab'}} />
        
        <div style={{position:'absolute', top:20, left:20, display:'flex', gap:6}}>
            <button onClick={()=>setCam(c=>({...c, yaw:0, pitch:0}))} style={btnStyle}>FRONT</button>
            <button onClick={()=>setCam(c=>({...c, yaw:0, pitch:1.57}))} style={btnStyle}>TOP</button>
            <button onClick={()=>setCam(c=>({...c, yaw:1.57, pitch:0}))} style={btnStyle}>SIDE</button>
            <button onClick={()=>setCam(defaultCam)} style={{...btnStyle, color:'#f78166'}}>RESET</button>
        </div>

        <div style={{position:'absolute', bottom:20, left:20, fontSize:10, color:'#8b949e', background:'rgba(0,0,0,0.7)', padding:10, borderRadius:5}}>
            YAW: {cam.yaw.toFixed(2)} | PITCH: {cam.pitch.toFixed(2)} | DIST: {cam.dist.toFixed(0)} <br/>
            DRAG TO ORBIT • SCROLL TO ZOOM
        </div>
      </div>

      <div style={{width: 450, padding:0, overflowY:'auto', background:'#010409', display:'flex', flexDirection:'column'}}>
        
        {/* SHADER EDITOR */}
        <div style={{padding:20, borderBottom:'1px solid #30363d'}}>
            <h4 style={{margin:'0 0 10px 0', color:'#f78166'}}>UE5 HLSL SHADER LAB</h4>
            <textarea value={code} onChange={e=>setCode(e.target.value)} spellCheck="false"
                style={{width:'100%', height:280, background:'#0d1117', color:'#79c0ff', border:'1px solid #30363d', padding:10, fontSize:11, lineHeight:'1.5'}} />
        </div>

        {/* VISUALIZER TOGGLES */}
        <div style={{padding:20, borderBottom:'1px solid #30363d', background:'#090d13'}}>
            <h4 style={{margin:'0 0 10px 0', color:'#a5d6ff'}}>LEARNING VISUALIZERS</h4>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                <label style={checkStyle}><input type="checkbox" checked={vis.mesh} onChange={()=>toggleVis('mesh')} /> Page Mesh</label>
                <label style={checkStyle}><input type="checkbox" checked={vis.crease} onChange={()=>toggleVis('crease')} /> <span style={{color:'#ffcc00'}}>■</span> Crease Line</label>
                {params.PrimaryRadius !== undefined && (
                    <label style={checkStyle}><input type="checkbox" checked={vis.primaryArc} onChange={()=>toggleVis('primaryArc')} /> <span style={{color:'#22c55e'}}>■</span> Primary Arc</label>
                )}
                {params.SecondaryRadius !== undefined && (
                    <label style={checkStyle}><input type="checkbox" checked={vis.secondaryArc} onChange={()=>toggleVis('secondaryArc')} /> <span style={{color:'#3b82f6'}}>■</span> Secondary Arc</label>
                )}
            </div>
            <p style={{fontSize:10, color:'#8b949e', marginTop:10, marginBottom:0, lineHeight:'1.4'}}>
                * The visualizer lines are passed through your custom HLSL code in real-time. If you change the math above, the visualizer curves will adapt automatically.
            </p>
        </div>

        {/* PARAMETERS */}
        <div style={{padding:20}}>
            <h4 style={{margin:'0 0 10px 0', color:'#c9d1d9'}}>PARAMETERS</h4>
            <div style={{display:'grid', gap:12}}>
                <Param label="Flip Progress" val={params.FlipAlpha} min={0} max={1} step={0.01} onChange={v=>setParams({...params, FlipAlpha:v})} />
                <Param label="Peel Angle" val={params.PeelAngle} min={0} max={360} step={1} onChange={v=>setParams({...params, PeelAngle:v})} />
                <Param label="Primary Radius" val={params.PrimaryRadius} min={1} max={50} onChange={v=>setParams({...params, PrimaryRadius:v})} />
                <Param label="Secondary Radius" val={params.SecondaryRadius} min={1} max={50} onChange={v=>setParams({...params, SecondaryRadius:v})} />
                <hr style={{width:'100%', border:'0.5px solid #30363d', margin:'5px 0'}}/>
                <Param label="Page Width" val={params.PageWidth} min={50} max={200} onChange={v=>setParams({...params, PageWidth:v})} />
                <Param label="Page Height" val={params.PageHeight} min={50} max={250} onChange={v=>setParams({...params, PageHeight:v})} />
                <Param label="Origin X" val={params.PeelOriginX} min={0} max={params.PageWidth} onChange={v=>setParams({...params, PeelOriginX:v})} />
            </div>
        </div>
      </div>
    </div>
  );
}

function Param({label, val, min, max, step=1, onChange}) {
    return ( <div style={{fontSize:11}}><div style={{display:'flex', justifyContent:'space-between', marginBottom:4}}><span>{label.toUpperCase()}</span><span style={{color:'#79c0ff'}}>{val}</span></div><input type="range" min={min} max={max} step={step} value={val} onChange={e=>onChange(parseFloat(e.target.value))} style={{width:'100%'}}/></div>);
}
const btnStyle = { background:'#21262d', border:'1px solid #30363d', color:'#c9d1d9', padding:'4px 10px', fontSize:10, borderRadius:4, cursor:'pointer' };
const checkStyle = { fontSize:11, display:'flex', alignItems:'center', gap:5, cursor:'pointer' };