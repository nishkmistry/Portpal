import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as d3 from "d3";
import "./PortMap.css";

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  port: number;
  pid: number;
  process_name: string;
  project_name: string | null;
  framework: string | null;
  is_dev: boolean;
  connection_count: number;
}
interface GraphEdge extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  active: boolean;
}
interface PortGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

const FW_COLORS: Record<string, string> = {
  React:"#61dafb",Vite:"#646cff",Angular:"#dd0031",
  Node:"#68a063",Django:"#2bbc8a",HTTP:"#f0a500",
  Jupyter:"#f37626",Postgres:"#336791",MySQL:"#4479a1",
  Redis:"#dc382d",Mongo:"#4db33d",PHP:"#8892bf",
  Tauri:"#ffc131",HTTPS:"#22c55e",
};

function nodeColor(n: GraphNode) {
  return (n.framework && FW_COLORS[n.framework]) || (n.is_dev ? "#7c6fff" : "#4a4a6a");
}
function nodeR(n: GraphNode) {
  return n.is_dev ? 26 : 18;
}

export default function PortMap({ onClose }: { onClose: () => void }) {
  const svgRef   = useRef<SVGSVGElement>(null);
  const canvasRef= useRef<HTMLCanvasElement>(null);
  const simRef   = useRef<d3.Simulation<GraphNode,GraphEdge>|null>(null);
  const rafRef   = useRef<number>(0);
  const [graph, setGraph]       = useState<PortGraph>({nodes:[],edges:[]});
  const [selected, setSelected] = useState<GraphNode|null>(null);
  const [loading, setLoading]   = useState(true);

  const graphRef = useRef<string>("");

  const fetchGraph = useCallback(async () => {
    try {
      const g = await invoke<PortGraph>("get_port_graph");
      const key = JSON.stringify(g);
      if (key !== graphRef.current) {
        graphRef.current = key;
        setGraph(g);
      }
    } catch { } finally { setLoading(false); }
  }, []);

  // Fetch once on mount, then listen for backend port-change events
  useEffect(() => {
    fetchGraph();
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("ports-updated", () => {
        fetchGraph();
      }).then((fn) => { unlisten = fn; });
    });
    return () => { if (unlisten) unlisten(); };
  }, [fetchGraph]);

  // Particle canvas background
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cvs = canvas;
    const wrap = cvs.parentElement!;
    const ctx = cvs.getContext("2d")!;

    let W = 0, H = 0;
    let raf: number;
    let pts: Array<{x:number;y:number;vx:number;vy:number;r:number;op:number}> = [];

    function resize() {
      W = wrap.clientWidth || window.innerWidth;
      H = wrap.clientHeight || window.innerHeight;
      cvs.width = W;
      cvs.height = H;
      pts = Array.from({ length: 60 }, () => ({
        x: Math.random()*W, y: Math.random()*H,
        vx:(Math.random()-.5)*.3, vy:(Math.random()-.5)*.3,
        r: Math.random()*1.5+.5, op: Math.random()*.35+.05,
      }));
    }

    function draw() {
      if (W === 0 || H === 0) resize();
      ctx.clearRect(0,0,W,H);
      ctx.strokeStyle="rgba(124,111,255,0.04)"; ctx.lineWidth=.5;
      for(let x=0;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
      for(let y=0;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
      pts.forEach(p=>{
        p.x+=p.vx; p.y+=p.vy;
        if(p.x<0)p.x=W; if(p.x>W)p.x=0;
        if(p.y<0)p.y=H; if(p.y>H)p.y=0;
        ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fillStyle=`rgba(124,111,255,${p.op})`; ctx.fill();
      });
      const vg = ctx.createRadialGradient(W/2,H/2,H*.2,W/2,H/2,H*.8);
      vg.addColorStop(0,"rgba(0,0,0,0)"); vg.addColorStop(1,"rgba(0,0,12,0.75)");
      ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);
      raf = requestAnimationFrame(draw);
    }

    const observer = new ResizeObserver(() => resize());
    observer.observe(wrap);
    resize();
    draw();

    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, []);

  // D3 graph
  useEffect(() => {
    if (!svgRef.current || loading) return;
    const el = svgRef.current;
    const W = el.clientWidth || window.innerWidth;
    const H = el.clientHeight || window.innerHeight;
    const svg = d3.select(el);
    svg.selectAll("*").remove();
    if (simRef.current) simRef.current.stop();
    cancelAnimationFrame(rafRef.current);

    const defs = svg.append("defs");

    // Arrow
    defs.append("marker").attr("id","arr").attr("viewBox","0 0 10 10")
      .attr("refX",32).attr("refY",5).attr("markerWidth",6).attr("markerHeight",6)
      .attr("orient","auto-start-reverse")
      .append("path").attr("d","M2 1L8 5L2 9").attr("fill","none")
      .attr("stroke","rgba(124,111,255,0.5)").attr("stroke-width",1.5)
      .attr("stroke-linecap","round");

    // Glow helper
    function glow(id: string, std: number, color: string) {
      const f = defs.append("filter").attr("id",id)
        .attr("x","-80%").attr("y","-80%").attr("width","260%").attr("height","260%");
      f.append("feFlood").attr("flood-color",color).attr("result","c");
      f.append("feComposite").attr("in","c").attr("in2","SourceAlpha").attr("operator","in").attr("result","cc");
      f.append("feGaussianBlur").attr("in","cc").attr("stdDeviation",std).attr("result","blur");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in","blur");
      m.append("feMergeNode").attr("in","SourceGraphic");
    }
    glow("glow-sm",3,"rgba(124,111,255,0.8)");
    glow("glow-md",7,"rgba(124,111,255,0.5)");
    graph.nodes.forEach(n => glow(`gn-${n.id}`,5,nodeColor(n)));

    // Edge gradients
    graph.edges.forEach((e, i) => {
      const s = graph.nodes.find(n=>n.id===(typeof e.source==="string"?e.source:(e.source as GraphNode).id));
      const t = graph.nodes.find(n=>n.id===(typeof e.target==="string"?e.target:(e.target as GraphNode).id));
      const sc = s ? nodeColor(s) : "#7c6fff";
      const tc = t ? nodeColor(t) : "#7c6fff";
      const g = defs.append("linearGradient").attr("id",`eg${i}`).attr("gradientUnits","userSpaceOnUse");
      g.append("stop").attr("offset","0%").attr("stop-color",sc).attr("stop-opacity",.1);
      g.append("stop").attr("offset","50%").attr("stop-color","rgba(160,150,255,0.9)");
      g.append("stop").attr("offset","100%").attr("stop-color",tc).attr("stop-opacity",.1);
    });

    const container = svg.append("g");
    svg.call(d3.zoom<SVGSVGElement,unknown>().scaleExtent([.25,4])
      .on("zoom", e => container.attr("transform", e.transform)));

    const simNodes: GraphNode[] = graph.nodes.map(n=>({...n}));
    const simEdges: GraphEdge[] = graph.edges.map(e=>({...e,
      source: typeof e.source==="string" ? e.source : (e.source as GraphNode).id,
      target: typeof e.target==="string" ? e.target : (e.target as GraphNode).id,
    }));

    const sim = d3.forceSimulation<GraphNode>(simNodes)
      .force("link", d3.forceLink<GraphNode,GraphEdge>(simEdges)
        .id(d=>d.id).distance(140).strength(.45))
      .force("charge", d3.forceManyBody().strength(d=>(d as GraphNode).is_dev?-500:-280))
      .force("center", d3.forceCenter(W/2, H/2))
      .force("collide", d3.forceCollide<GraphNode>().radius(d=>nodeR(d)+28));
    simRef.current = sim;

    const edgeG = container.append("g");

    // Dashed arc edges
    const edgePaths = edgeG.selectAll<SVGPathElement,GraphEdge>(".ep")
      .data(simEdges).enter().append("path")
      .attr("fill","none")
      .attr("stroke",(_,i)=>`url(#eg${i})`)
      .attr("stroke-width",1.5)
      .attr("stroke-dasharray","5 5")
      .attr("opacity",.65)
      .attr("marker-end","url(#arr)");

    // Animated flow
    const flowPaths = edgeG.selectAll<SVGPathElement,GraphEdge>(".fp")
      .data(simEdges).enter().append("path")
      .attr("fill","none")
      .attr("stroke","rgba(210,200,255,0.95)")
      .attr("stroke-width",2.5)
      .attr("stroke-dasharray","2 30");

    // Glow overlay on edges
    const glowPaths = edgeG.selectAll<SVGPathElement,GraphEdge>(".gp")
      .data(simEdges).enter().append("path")
      .attr("fill","none")
      .attr("stroke","rgba(124,111,255,0.25)")
      .attr("stroke-width",6)
      .attr("stroke-dasharray","5 5")
      .attr("filter","url(#glow-sm)");

    function arcPath(s: GraphNode, t: GraphNode) {
      const dx=(t.x||0)-(s.x||0), dy=(t.y||0)-(s.y||0);
      const dr=Math.sqrt(dx*dx+dy*dy)*1.4;
      return `M${s.x},${s.y} A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
    }

    // Node groups
    const nodeGs = container.append("g").selectAll<SVGGElement,GraphNode>(".ng")
      .data(simNodes).enter().append("g").attr("class","ng")
      .style("cursor","pointer")
      .call(d3.drag<SVGGElement,GraphNode>()
        .on("start",(e,d)=>{if(!e.active)sim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;})
        .on("drag",(e,d)=>{d.fx=e.x;d.fy=e.y;})
        .on("end",(e,d)=>{if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null;})
      )
      .on("click",(ev,d)=>{ev.stopPropagation();setSelected(p=>p?.id===d.id?null:d);});

    svg.on("click",()=>setSelected(null));

    // Outer decorative ring
    nodeGs.append("circle")
      .attr("r",d=>nodeR(d)+26)
      .attr("fill","none")
      .attr("stroke",d=>nodeColor(d))
      .attr("stroke-width",.5)
      .attr("stroke-dasharray","2 8")
      .attr("opacity",.1);

    // Mid glow ring
    nodeGs.append("circle")
      .attr("r",d=>nodeR(d)+14)
      .attr("fill","none")
      .attr("stroke",d=>nodeColor(d))
      .attr("stroke-width",.8)
      .attr("opacity",.18)
      .attr("filter",d=>`url(#gn-${d.id})`);

    // Core
    nodeGs.append("circle").attr("class","core")
      .attr("r",d=>nodeR(d))
      .attr("fill",d=>`${nodeColor(d)}1a`)
      .attr("stroke",d=>nodeColor(d))
      .attr("stroke-width",1.5)
      .attr("filter",d=>`url(#gn-${d.id})`);

    // Inner bright spot
    nodeGs.append("circle")
      .attr("r",d=>nodeR(d)*.3)
      .attr("fill",d=>nodeColor(d))
      .attr("opacity",.45)
      .attr("filter",d=>`url(#gn-${d.id})`);

    // Port label
    nodeGs.append("text")
      .attr("text-anchor","middle").attr("dominant-baseline","central")
      .attr("dy",d=>d.project_name?"-9":"0")
      .attr("font-family","JetBrains Mono,monospace")
      .attr("font-size",d=>d.is_dev?"12":"10")
      .attr("font-weight","700")
      .attr("fill",d=>nodeColor(d))
      .attr("letter-spacing","-.01em")
      .text(d=>`:${d.port}`);

    // Project name
    nodeGs.filter(d=>!!d.project_name).append("text")
      .attr("text-anchor","middle").attr("dominant-baseline","central")
      .attr("dy","8").attr("font-family","Geist,sans-serif").attr("font-size","8")
      .attr("fill","rgba(255,255,255,0.35)")
      .text(d=>d.project_name!.slice(0,10));

    // Framework badge
    nodeGs.filter(d=>!!d.framework).append("text")
      .attr("text-anchor","middle")
      .attr("font-family","Geist,sans-serif").attr("font-size","7")
      .attr("font-weight","700").attr("letter-spacing",".1em")
      .attr("fill",d=>nodeColor(d)).attr("opacity",.75)
      .attr("dy",d=>d.is_dev?-42:-32)
      .text(d=>d.framework!.toUpperCase());

    // Connection count badge
    nodeGs.filter(d=>d.connection_count>0).append("circle")
      .attr("cx",d=>nodeR(d)-2).attr("cy",d=>-(nodeR(d)-2))
      .attr("r",7).attr("fill","#080818")
      .attr("stroke","rgba(124,111,255,0.45)").attr("stroke-width",1);

    nodeGs.filter(d=>d.connection_count>0).append("text")
      .attr("x",d=>nodeR(d)-2).attr("y",d=>-(nodeR(d)-2))
      .attr("text-anchor","middle").attr("dominant-baseline","central")
      .attr("font-family","JetBrains Mono,monospace")
      .attr("font-size","7").attr("font-weight","700")
      .attr("fill","rgba(200,190,255,0.9)")
      .text(d=>String(d.connection_count));

    // Tick
    sim.on("tick",()=>{
      const path=(d: GraphEdge)=>arcPath(d.source as GraphNode, d.target as GraphNode);
      edgePaths.attr("d",path);
      flowPaths.attr("d",path);
      glowPaths.attr("d",path);
      nodeGs.attr("transform",d=>`translate(${d.x||0},${d.y||0})`);
    });

    // Animate flow
    let off=0;
    function anim(){
      off-=.9;
      flowPaths.attr("stroke-dashoffset",off);
      glowPaths.attr("stroke-dashoffset",off*.5);
      rafRef.current=requestAnimationFrame(anim);
    }
    anim();

    // Pulse dev nodes
    function pulseNodes(){
      nodeGs.filter(d=>d.is_dev).select(".core")
        .transition().duration(1400).attr("opacity",.9)
        .transition().duration(1400).attr("opacity",.6)
        .on("end",pulseNodes);
    }
    setTimeout(pulseNodes,300);

    // Entrance
    nodeGs.attr("opacity",0)
      .transition().delay((_,i)=>i*70).duration(500).attr("opacity",1);

    return () => { sim.stop(); cancelAnimationFrame(rafRef.current); };
  }, [graph, loading]);

  // Highlight selected
  useEffect(()=>{
    if(!svgRef.current)return;
    const svg=d3.select(svgRef.current);
    svg.selectAll<SVGCircleElement,GraphNode>(".core")
      .attr("stroke-width",d=>selected?.id===d.id?3:1.5)
      .attr("fill",d=>selected?.id===d.id?`${nodeColor(d)}35`:`${nodeColor(d)}1a`);
  },[selected]);

  return (
    <div className="pm-wrap">
      <canvas ref={canvasRef} className="pm-bg" />
      <svg ref={svgRef} className="pm-svg" />

      <div className="pm-header">
        <div className="pm-header-left">
          <div className="pm-dot" />
          <div>
            <div className="pm-title">PORT MAP</div>
            <div className="pm-sub">
              {graph.nodes.length} nodes · {graph.edges.length} connections
            </div>
          </div>
        </div>
        <div className="pm-header-right">
          <span className="pm-scan-txt">LIVE SCAN</span>
          <div className="pm-pulse" />
          <button className="pm-icon-btn pm-refresh-btn" onClick={fetchGraph}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M10 6A4 4 0 1 1 6 2M6 2l2-2M6 2L4 0"
                stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button className="pm-icon-btn pm-close-btn" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {loading && (
        <div className="pm-loading">
          <div className="pm-loader" />
          <span>Mapping connections…</span>
        </div>
      )}

      {!loading && graph.nodes.length===0 && (
        <div className="pm-empty">
          <div className="pm-empty-ring" />
          <span>No ports to map</span>
          <span className="pm-empty-sub">Start some servers and come back</span>
        </div>
      )}

      {selected && (
        <div className="pm-inspector">
          <div className="pmi-port" style={{color:nodeColor(selected)}}>
            :{selected.port}
          </div>
          <div className="pmi-name">
            {selected.project_name ?? selected.process_name}
          </div>
          {selected.framework && (
            <span className="pmi-badge" style={{
              color:nodeColor(selected),
              borderColor:`${nodeColor(selected)}55`,
              background:`${nodeColor(selected)}18`,
            }}>
              {selected.framework}
            </span>
          )}
          <div className="pmi-row"><span>PID</span><span>{selected.pid}</span></div>
          <div className="pmi-row"><span>Process</span><span>{selected.process_name}</span></div>
          <div className="pmi-row"><span>Connections</span><span>{selected.connection_count}</span></div>
          <button className="pmi-kill" onClick={async()=>{
            await invoke("kill_process",{pid:selected.pid});
            setSelected(null); fetchGraph();
          }}>
            Kill process
          </button>
        </div>
      )}

      <div className="pm-legend">
        <div className="pm-leg-items">
          {[["#61dafb","Dev server"],["#4a4a6a","System"],["#22c55e","Database"]]
            .map(([c,l])=>(
              <div key={l} className="pm-leg-item">
                <div className="pm-leg-dot" style={{background:c,boxShadow:`0 0 4px ${c}`}}/>
                {l}
              </div>
            ))}
        </div>
        <span className="pm-leg-txt">DRAG · SCROLL TO ZOOM · CLICK TO INSPECT</span>
      </div>
    </div>
  );
}
