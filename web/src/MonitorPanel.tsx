/* 监控右栏(自 keeper MonitorPanel 移植):主机卡(CPU/内存大字+CPU 2h 曲线+GPU/存储行)
   + URL 探针卡(keeper {rows,bar,value} 协议 / 原始 JSON 拍平)+ 收起态窄轨。
   去 dnd-kit(KeeTerm 不引):卡片序=mon.toml 声明序;数据 15s 后端采集,前端 15s 拉取。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, cn, toast } from "./lib";
import { t } from "./i18n";
import { Activity, Cpu, Image as ImageIcon, Plus, Server, type LucideIcon } from "lucide-react";

type Row = { k: string; v: string };
type HostStat = { online?: boolean; rows?: Row[]; hist?: number[] };
type Hosts = Record<string, HostStat>;
type Probe = { name: string; url: string; online: boolean; ts?: number; data?: { rows?: Row[]; bar?: { text: string; pct: number } } | null; hist?: number[] };

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span title={now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
      className="ml-auto pr-1 text-[13px] font-medium tabular-nums text-muted-foreground">
      {now.toLocaleTimeString("zh-CN", { hour12: false })}
    </span>
  );
}

/** 利用率分档(keeper 档位):<10 灰、10-85 绿、85-95 黄、≥95 红 */
function utilColor(u: number): string {
  if (u < 10) return "text-muted-foreground";
  if (u < 85) return "text-[#3fb950]";
  if (u < 95) return "text-[#d29922]";
  return "text-[#f85149]";
}
function diskColor(pct: number): string {
  if (pct < 70) return "text-[#3fb950]";
  if (pct < 90) return "text-[#d29922]";
  return "text-[#f85149]";
}

function machineRows(src: HostStat) {
  const rows = src.rows || [];
  if (!src.online) {
    const ks = [...Array.from({ length: rows.filter((r) => /^GPU/.test(r.k)).length }, () => "GPU"), "存储"];
    return ks.map((kk, i) => (
      <div key={`${kk}-${i}`} className="flex justify-between gap-2.5 py-px text-[13px] text-muted-foreground/60">
        <b className="font-normal">{kk}</b><span>–</span>
      </div>
    ));
  }
  return rows
    .filter((r) => /^GPU/.test(r.k) || r.k === "存储")
    .map((r, i) => {
      const mm = r.v.match(/^(\d+)%(.*)$/);
      return (
        <div key={`${r.k}-${i}`} className="flex justify-between gap-2.5 py-px text-[13px]">
          <b className="font-normal">{r.k}</b>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            {mm ? (<><span className={/^GPU/.test(r.k) ? utilColor(+mm[1]) : diskColor(+mm[1])}>{mm[1]}%</span>{mm[2]}</>) : r.v}
          </span>
        </div>
      );
    });
}

/** CPU 小曲线:0-100 固定尺度、50% 虚线标尺、按最新值变色 */
function Spark({ hist }: { hist?: number[] }) {
  const w = 84, h = 18;
  if (!hist || hist.length < 3) return (
    <svg width={w} height={h} className="shrink-0 self-center">
      <title>暂无 CPU 曲线数据</title>
      <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="hsl(var(--secondary))" strokeWidth="1.4" strokeDasharray="3 3" />
    </svg>
  );
  const pts = hist.map((v, i) =>
    `${((i / (hist.length - 1)) * w).toFixed(1)},${(h - (Math.min(v, 100) / 100) * h).toFixed(1)}`).join(" ");
  const cur = hist[hist.length - 1];
  return (
    <svg width={w} height={h} className="shrink-0 self-center">
      <title>{`CPU 近 2h(${hist.length} 拍):最高 ${Math.max(...hist)}% / 最新 ${cur}%`}</title>
      <line x1="0" y1="0.5" x2={w} y2="0.5" stroke="hsl(var(--secondary))" strokeWidth="1" />
      <line x1="0" y1={h - 0.5} x2={w} y2={h - 0.5} stroke="hsl(var(--secondary))" strokeWidth="1" />
      <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="hsl(var(--border))" strokeDasharray="3 2" strokeWidth="1" />
      <text x={w} y={h / 2 - 1.5} fontSize="7" fill="hsl(var(--muted-foreground))" textAnchor="end">50</text>
      <polyline points={pts} fill="none" stroke={cur > 80 ? "#f85149" : cur > 50 ? "#d29922" : "#3fb950"} strokeWidth="1.4" />
    </svg>
  );
}

/** 卡头 CPU/内存大字:百分比大字按水位变色,内存总量小灰字 */
function KpiInline({ k, v }: { k: string; v: string }) {
  const mm = v.match(/^(\d+)%/);
  if (!mm) return (
    <span className="flex items-baseline gap-0.5 whitespace-nowrap" title={v}>
      <span className="text-[11px] font-normal text-muted-foreground">{k}</span>
      <span className="text-base font-semibold leading-none text-muted-foreground/60">–</span>
    </span>
  );
  const pct = +mm[1];
  const color = pct > 80 ? "#f85149" : pct > 50 ? "#d29922" : "#3fb950";
  const tot = k === "内存" ? /(\d+(?:\.\d+)?[GT])/i.exec(v.slice(mm[0].length))?.[1] : undefined;
  return (
    <span className="flex items-baseline gap-0.5 whitespace-nowrap" title={`${k} ${v}`}>
      <span className="text-[11px] font-normal text-muted-foreground">{k}</span>
      <span className="text-base font-semibold leading-none tabular-nums" style={{ color }}>{pct}%</span>
      {tot && <span className="text-[11px] font-normal leading-none text-muted-foreground">/{tot}</span>}
    </span>
  );
}

function ResCard({ k, src }: { k: string; src: HostStat }) {
  const hasGpu = (src.rows || []).some((r) => /^GPU/.test(r.k));
  const MIcon: LucideIcon = hasGpu ? Cpu : Server;
  let kpis = (src.rows || []).filter((r) => r.k === "CPU" || r.k === "内存");
  if (!src.online) kpis = ["CPU", "内存"].map((kk) => kpis.find((r) => r.k === kk) || { k: kk, v: "–" });
  return (
    <div data-rescard={k} title={k}
      className={cn("flex flex-col cursor-default rounded-[10px] border border-border/70 px-3 py-2", !src.online && "opacity-60 grayscale")}>
      <div className="flex items-center gap-1.5 pb-0.5 text-[13px] font-semibold">
        <span className="whitespace-nowrap">
          <MIcon className={cn("inline size-4 align-[-2px]", src.online ? "text-[#3fb950]" : "text-muted-foreground")} /> {k}
        </span>
        {kpis.length > 0 && (
          <span className="ml-auto flex items-baseline gap-2.5">
            {kpis.map((r) => <KpiInline key={r.k} k={r.k} v={r.v} />)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2"><Spark hist={src.hist} /></div>
      <div className="flex flex-1 flex-col text-[13px]">{machineRows(src)}</div>
    </div>
  );
}

/** 原始 JSON 探针:拍平显示(点路径),_age_s 结尾数值转相对时间 */
const ageTxt = (s?: number | null): string => {
  if (s == null || s < 0) return "–";
  if (s < 90) return `${Math.round(s)}s 前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h 前`;
  return `${(s / 86400).toFixed(1)} 天前`;
};
const valTxt = (k: string, v: unknown): string => {
  if (v == null) return "–";
  if (typeof v === "number" && /_age_s$/.test(k)) return ageTxt(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
function flattenJson(v: unknown, prefix: string, out: { k: string; v: string }[], depth: number) {
  if (v == null || typeof v !== "object" || Array.isArray(v) || depth >= 4) {
    if (prefix) out.push({ k: prefix, v: valTxt(prefix, v) });
    return;
  }
  const ks = Object.keys(v as Record<string, unknown>);
  if (ks.length === 0) { if (prefix) out.push({ k: prefix, v: "{}" }); return; }
  for (const kk of ks) flattenJson((v as Record<string, unknown>)[kk], prefix ? `${prefix}.${kk}` : kk, out, depth + 1);
}

const toneColor = (t?: string) =>
  t === "danger" ? "text-[#f85149]" : t === "warn" ? "text-[#d29922]" : t === "ok" ? "text-[#3fb950]" : undefined;

function ProbeSpark({ hist }: { hist?: number[] }) {
  if (!hist || hist.length < 3) return (
    <svg width={84} height={18} className="shrink-0 self-center">
      <title>暂无曲线数据(value/bar.pct 采点)</title>
      <line x1="0" y1="9" x2="84" y2="9" stroke="hsl(var(--secondary))" strokeWidth="1.4" strokeDasharray="3 3" />
    </svg>
  );
  const w = 84, h = 18;
  const max = Math.max(...hist, 1e-9);
  const pts = hist.map((v, i) => `${((i / (hist.length - 1)) * w).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="shrink-0 self-center">
      <title>{`近 2h(${hist.length} 点):峰值 ${max.toFixed(1)} / 最新 ${hist[hist.length - 1].toFixed(1)}`}</title>
      <polyline points={pts} fill="none" stroke="#3fb950" strokeWidth="1.4" />
    </svg>
  );
}

const isRawProbe = (p: Probe) => !!p.data && !(p.data as Record<string, unknown>).rows;

function RawJsonCard({ p }: { p: Probe }) {
  const rows: { k: string; v: string }[] = [];
  flattenJson(p.data, "", rows, 0);
  return (
    <div className="cursor-default rounded-[10px] border border-border/70 px-3 py-2" title={`${p.name} · ${p.url}`}>
      <div className="flex items-center gap-1.5 pb-0.5 text-[13px] font-semibold">
        <ImageIcon className={cn("inline size-4 align-[-2px]", p.online ? "text-[#3fb950]" : "text-muted-foreground")} /> {p.name}
      </div>
      <div className="text-[13px]">
        {!p.online && <div className="flex justify-between gap-2.5 py-px text-muted-foreground/60"><b className="font-normal">状态</b><span>–</span></div>}
        {p.online && rows.map((r, i) => (
          <div key={i} className="flex justify-between gap-2.5 py-px">
            <b className="shrink-0 font-normal text-muted-foreground">{r.k}</b>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap" title={r.v}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProbeCard({ p }: { p: Probe }) {
  const d: any = p.data || {};
  const rows: Row[] = d.rows || [];
  const bar = d.bar;
  return (
    <div className="cursor-default rounded-[10px] border border-border/70 px-3 py-2" title={`${p.name} · ${p.url}`}>
      <div className="flex items-center gap-1.5 pb-0.5 text-[13px] font-semibold">
        <ImageIcon className={cn("inline size-4 align-[-2px]", p.online ? "text-[#3fb950]" : "text-muted-foreground")} /> {p.name}
        {bar && <span className="ml-auto text-base font-semibold leading-none tabular-nums">{Math.round(bar.pct)}%</span>}
        {!bar && typeof d.sum === "string" && <span className="ml-auto text-[13px] font-semibold leading-none tabular-nums">{d.sum}</span>}
      </div>
      <div className="flex items-center gap-2"><ProbeSpark hist={p.hist} /></div>
      <div className="text-[13px]">
        {!p.online && <div className="flex justify-between gap-2.5 py-px text-muted-foreground/60"><b className="font-normal">状态</b><span>–</span></div>}
        {p.online && rows.map((r, i) => (
          <div key={i} className="flex justify-between gap-2.5 py-px">
            <b className="font-normal">{r.k}</b>
            <span className={cn("overflow-hidden text-ellipsis whitespace-nowrap", toneColor((r as any).tone))} title={r.v}>{r.v}</span>
          </div>
        ))}
        {p.online && bar && (
          <div className="relative mt-1 h-3 overflow-hidden rounded-full bg-secondary" title={bar.text}>
            <span className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.15)_0_5px,transparent_5px_10px)]" />
            <div className="absolute inset-y-0 left-0 rounded-full bg-[#3fb950]" style={{ width: `${Math.min(100, Math.max(0, bar.pct))}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 收起态窄轨:一主机一组小格(CPU/内存/GPU/显存,有则显);探针一格=bar.pct/– */
function MiniRail({ hosts, probes, onToggle }: { hosts: Hosts | null; probes: Probe[]; onToggle?: () => void }) {
  const keys = [...Object.keys(hosts || {}), ...(hosts ? probes.map((p) => `probe:${p.name}`) : [])];
  const byKey = useMemo(() => new Map(probes.map((p) => [`probe:${p.name}`, p])), [probes]);
  const vmemPct = (v: string) => {
    const m = /(\d+(?:\.\d+)?)\s*(?:MiB|GiB)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:MiB|GiB)/.exec(v);
    if (!m) return null;
    const t = parseFloat(m[2]);
    return t > 0 ? Math.round((parseFloat(m[1]) / t) * 100) : null;
  };
  const pctOf = (v: string) => { const m = /^(\d+)/.exec(v); return m ? +m[1] : null; };
  const Cell = ({ label, pct, raw, title, color }: { label: string; pct?: number | null; raw?: string; title?: string; color?: string }) => (
    <div title={title} className="flex flex-col items-center leading-none">
      <span className="text-[9px] text-muted-foreground">{label}</span>
      <span className={cn("text-base font-semibold tabular-nums", color ?? "text-muted-foreground")}>
        {raw ?? (pct == null ? "–" : `${pct}%`)}
      </span>
    </div>
  );
  return (
    <div onClick={onToggle}
      className="thin-scroll flex max-h-full min-h-full cursor-pointer flex-col items-center gap-2.5 overflow-y-auto py-2.5">
      {keys.map((k) => {
        if (byKey.has(k)) {
          const p = byKey.get(k)!;
          // 无 bar.pct 时 sum "X/Y" 直显当前数 X(keeper MiniRail 同款);都没有显在线状态
          const m = typeof (p.data as any)?.sum === "string" ? /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec((p.data as any).sum.trim()) : null;
          const summary = ((p.data as any)?.rows || []).map((r: Row) => `${r.k} ${r.v}`).join(" · ")
            || (p.data ? Object.entries(p.data as Record<string, unknown>).slice(0, 6).map(([kk, vv]) => `${kk} ${JSON.stringify(vv)}`).join(" · ") : "");
          return (
            <div key={k} className="flex w-full flex-col items-center gap-2.5">
              {k !== keys[0] && <span className="w-6 border-t border-border/60" aria-hidden />}
              <div className="max-w-full truncate px-0.5 text-[9px] leading-none text-muted-foreground/70">{p.name}</div>
              <Cell label={m ? "当前" : "状态"} pct={p.data?.bar?.pct == null ? null : Math.round(p.data.bar.pct)} raw={m ? m[1] : (p.online ? "√" : "–")}
                color={p.online ? "text-emerald-500" : undefined}
                title={`${p.name}${p.online ? "" : "(离线)"}:${summary || p.url}`} />
            </div>
          );
        }
        const src = (hosts || {})[k];
        const rows = src?.rows || [];
        const all = rows.map((x) => `${x.k} ${x.v}`).join(" · ");
        const title = `${k}${src?.online ? "" : "(离线)"}:${all || "—"}`;
        const online = !!src?.online;
        const cellOf = (label: string, v?: string, pOverride?: number | null) => {
          const p = !online ? null : (pOverride != null ? pOverride : (v != null ? pctOf(v) : null));
          const c = p == null ? "text-muted-foreground"
            : p > 80 ? "text-red-500" : p > 50 ? "text-amber-500" : "text-emerald-500";
          return <Cell key={label} label={label} pct={p} color={c} title={title} />;
        };
        const cpu = rows.find((x) => x.k === "CPU");
        const mem = rows.find((x) => x.k === "内存");
        const gpu = rows.find((x) => /^GPU/.test(x.k));
        const vm = online && gpu ? vmemPct(gpu.v) : null;
        return (
          <div key={k} className="flex w-full flex-col items-center gap-2.5">
            {k !== keys[0] && <span className="w-6 border-t border-border/60" aria-hidden />}
            <div className={`max-w-full truncate px-0.5 text-[9px] leading-none ${online ? "text-muted-foreground/70" : "text-muted-foreground/40"}`}>{k}</div>
            {cpu && cellOf("CPU", cpu.v)}
            {mem && cellOf("内存", mem.v)}
            {gpu && cellOf("GPU", gpu.v)}
            {vm != null && cellOf("显存", undefined, vm)}
          </div>
        );
      })}
    </div>
  );
}

/** 卡片键:主机=名,探针=probe:url(同 tab 拖拽统一键空间参与排序) */
const probeKey = (p: Probe) => `probe:${p.url}`;
function readOrder(): string[] {
  try { return JSON.parse(localStorage.getItem("tg_mon_order") || "[]") || []; } catch { return []; }
}

/** 右侧监控栏:头部 Activity 开关+时钟+配置;收起=窄轨,展开=卡片列(可拖拽排序) */
export default function MonitorAside() {
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem("tg_mon_open"); if (v != null) return v === "1"; } catch { /* */ }
    return true;
  });
  useEffect(() => { localStorage.setItem("tg_mon_open", open ? "1" : "0"); }, [open]);
  const [data, setData] = useState<{ hosts: Hosts; probes: Probe[] } | null>(null);
  const load = () => api<{ hosts: Hosts; probes: Probe[] }>("/api/t/mon")
    .then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const hosts = data?.hosts || {};
  const probes = data?.probes || [];

  // 配置对话框(+ 号):主机(可选 targets)/探针(名称+URL)
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfg, setCfg] = useState<{ hosts: string[]; probes: { name: string; url: string }[] }>({ hosts: [], probes: [] });
  const [targetNames, setTargetNames] = useState<string[]>([]);
  const openCfg = () => {
    api<{ hosts: string[]; probes: { name: string; url: string }[] }>("/api/t/mon/cfg")
      .then(c => setCfg({ hosts: c.hosts || [], probes: (c.probes || []).map(p => ({ name: p.name, url: p.url })) }))
      .catch(() => toast("读配置失败", true));
    api<{ targets: { name: string }[] }>("/api/t/targets")
      .then(r => setTargetNames((r.targets || []).map((t: any) => t.name))).catch(() => {});
    setCfgOpen(true);
  };
  const saveCfg = () => {
    const names = cfg.hosts.map(h => h.trim()).filter(Boolean);
    api("/api/t/mon/cfg", { method: "POST", body: JSON.stringify(cfg) })
      .then(() => {
        toast(t("已保存"));
        setCfgOpen(false);
        // 前端即时增删卡片(不等后端采集):删=剔除,新=灰占位卡,数据随后端并发轮次填充
        setData(d => {
          const oldH = d?.hosts || {};
          const hosts: Hosts = {};
          for (const n of names) hosts[n] = oldH[n] || { online: false, rows: [], hist: [] };
          const oldP = new Map((d?.probes || []).map(p => [p.url, p]));
          const probes = cfg.probes
            .filter(p => p.name.trim() && p.url.trim())
            .map(p => oldP.get(p.url.trim()) || { name: p.name.trim(), url: p.url.trim(), online: false, data: null, hist: [] });
          return { hosts, probes };
        });
        [1500, 3000, 5000, 8000].forEach(ms => setTimeout(load, ms));
      })
      .catch(e => toast(e instanceof Error ? e.message : String(e), true));
  };

  // 卡片拖拽排序(dnd 式:卡片跟指针纵向移动,其余让位;桌面移 6px/触屏长按 380ms 激活,避开列表滚动)
  const keys = useMemo(() => [...Object.keys(hosts), ...probes.map(probeKey)], [hosts, probes]);
  const [order, setOrder] = useState<string[]>(readOrder);
  useEffect(() => { localStorage.setItem("tg_mon_order", JSON.stringify(order)); }, [order]);
  const items = useMemo(() => {
    const out: string[] = [];
    for (const k of order) if (keys.includes(k) && !out.includes(k)) out.push(k);
    for (const k of keys) if (!out.includes(k)) out.push(k);
    return out;
  }, [order, keys]);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const rectsRef = useRef<{ top: number; center: number; h: number }[]>([]);
  const pressRef = useRef<{ id: number; k: string; from: number; startY: number; armed: boolean; timer: number } | null>(null);
  const dragRef = useRef<{ k: string; from: number; y: number; target: number } | null>(null);
  const [drag, setDragState] = useState<{ k: string; from: number; y: number; target: number } | null>(null);
  const setDrag = (d: { k: string; from: number; y: number; target: number } | null) => { dragRef.current = d; setDragState(d); };
  const measureCards = () => {
    const rs: { top: number; center: number; h: number }[] = [];
    cardRefs.current.forEach(el => { const r = el.getBoundingClientRect(); rs.push({ top: r.top, center: r.top + r.height / 2, h: r.height }); });
    rs.sort((a, b) => a.top - b.top);
    return rs;
  };
  const armCard = () => {
    const p = pressRef.current;
    if (!p || p.armed) return;
    p.armed = true;
    if (p.timer) clearTimeout(p.timer);
    rectsRef.current = measureCards();
    setDrag({ k: p.k, from: p.from, y: 0, target: p.from });
  };
  const onCardDown = (e: React.PointerEvent, k: string, from: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pressRef.current = { id: e.pointerId, k, from, startY: e.clientY, armed: false, timer: 0 };
    if (e.pointerType === "touch") {
      pressRef.current.timer = window.setTimeout(() => { armCard(); navigator.vibrate?.(30); }, 380);
    }
  };
  const onCardMove = (e: React.PointerEvent) => {
    const p = pressRef.current;
    if (!p || p.armed || e.pointerId !== p.id) return;
    const dy = Math.abs(e.clientY - p.startY);
    if (e.pointerType === "mouse" && dy > 6) armCard();
    else if (e.pointerType === "touch" && dy > 12) { if (p.timer) clearTimeout(p.timer); pressRef.current = null; }
  };
  useEffect(() => {
    if (!drag) return;
    const mv = (e: PointerEvent) => {
      const p = pressRef.current, d = dragRef.current;
      if (!p || !d) return;
      const y = e.clientY - p.startY;
      const rects = rectsRef.current;
      const centers = rects.map(r => r.center);
      const dc = centers[d.from] + y;
      let target = d.from;
      if (y > 0) { for (let i = rects.length - 1; i > d.from; i--) if (dc > centers[i]) { target = i; break; } }
      else if (y < 0) { for (let i = 0; i < d.from; i++) if (dc < centers[i]) { target = i; break; } }
      setDrag({ ...d, y, target });
    };
    const up = () => {
      const p = pressRef.current, d = dragRef.current;
      if (p?.timer) clearTimeout(p.timer);
      if (p && d && d.target !== d.from) {
        const moved = items[d.from];
        const nx = [...items];
        nx.splice(d.from, 1);
        nx.splice(d.target, 0, moved);
        setOrder(nx);
      }
      pressRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, items]);
  // 拖拽中的触摸滚动拦截
  useEffect(() => {
    const tm = (e: TouchEvent) => { if (dragRef.current) e.preventDefault(); };
    document.addEventListener("touchmove", tm, { passive: false, capture: true });
    return () => document.removeEventListener("touchmove", tm);
  }, []);

  return (
    <div className={cn("flex h-full shrink-0 flex-col border-l border-border/70 bg-card", open ? "w-[264px]" : "w-14")}>
      <div className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-2", !open && "justify-center px-0")}>
        <button type="button" onClick={() => setOpen(v => !v)} title={t("展开/缩起监控栏")}
          className="flex cursor-pointer items-center p-0 text-base font-semibold text-foreground hover:text-primary">
          <Activity className="inline size-4" />
        </button>
        {open && <>
          <span className="text-[13px] font-semibold">{t("监控")}</span>
          <LiveClock />
          <button onClick={openCfg} title={t("配置监控项(主机 / URL 探针)")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <Plus className="size-3.5" />
          </button>
        </>}
      </div>
      {!open ? (
        <MiniRail hosts={hosts} probes={probes} onToggle={() => setOpen(true)} />
      ) : (
        <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
          onClick={e => { if (e.target === e.currentTarget) setOpen(v => !v); }}>   {/* 点空白(非卡片)切换展开/缩起 */}
          {Object.keys(hosts).length === 0 && probes.length === 0 && (
            <div className="py-2 text-center text-[13px] text-muted-foreground">
              暂无监控项<br />
              <button onClick={openCfg} className="text-[12px] text-primary hover:underline">点右上 + 配置</button>
            </div>
          )}
          {items.map((k, idx) => {
            const isDragged = drag?.k === k;
            const shift = (() => {
              if (!drag || isDragged) return 0;
              const h = (rectsRef.current[drag.from]?.h ?? 0) + 8;   // +gap
              if (drag.from < drag.target && idx > drag.from && idx <= drag.target) return -h;
              if (drag.from > drag.target && idx >= drag.target && idx < drag.from) return h;
              return 0;
            })();
            return (
              <div key={k}
                ref={el => { if (el) cardRefs.current.set(k, el); else cardRefs.current.delete(k); }}
                onPointerDown={e => onCardDown(e, k, idx)}
                onPointerMove={onCardMove}
                onPointerUp={() => {
                  const p = pressRef.current;
                  if (p && !p.armed) { if (p.timer) clearTimeout(p.timer); pressRef.current = null; }
                }}
                style={isDragged
                  ? { transform: `translateY(${drag!.y}px)`, zIndex: 10, position: "relative" as const }
                  : shift ? { transform: `translateY(${shift}px)`, transition: "transform 150ms" } : undefined}
                className={cn("min-w-0 bg-card", isDragged && "ring-2 ring-primary rounded-[10px]")}>
                {k.startsWith("probe:")
                  ? (() => {
                    const p = probes.find(x => probeKey(x) === k);
                    if (!p) return null;
                    return isRawProbe(p) ? <RawJsonCard p={p} /> : <ProbeCard p={p} />;
                  })()
                  : hosts[k] ? <ResCard k={k} src={hosts[k]} /> : null}
              </div>
            );
          })}
        </div>
      )}

      {/* 配置对话框 */}
      {cfgOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) setCfgOpen(false); }}>
          <div className="max-h-[85vh] w-[30rem] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="mb-3 text-sm font-medium">监控配置</div>
            <datalist id="mon-targets">{targetNames.map(n => <option key={n} value={n} />)}</datalist>
            <div className="grid gap-2.5 text-[13px]">
              <div>
                <div className="mb-1 text-[12px] font-medium text-muted-foreground">{t("主机(采集 CPU/内存/存储/GPU)")}</div>
                {cfg.hosts.map((h, i) => (
                  <div key={i} className="mb-1 flex items-center gap-1.5">
                    <input value={h} list="mon-targets" onChange={e => setCfg(c => ({ ...c, hosts: c.hosts.map((x, j) => j === i ? e.target.value : x) }))}
                      placeholder={t("目标名(ssh config / 已登记)")}
                      className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring" />
                    <button title="移除" onClick={() => setCfg(c => ({ ...c, hosts: c.hosts.filter((_, j) => j !== i) }))}
                      className="rounded p-1 text-muted-foreground/60 hover:text-red-500">✕</button>
                  </div>
                ))}
                <button onClick={() => setCfg(c => ({ ...c, hosts: [...c.hosts, ""] }))}
                  className="rounded px-1.5 py-1 text-[12px] text-primary hover:bg-accent">{t("+ 添加主机")}</button>
              </div>
              <div>
                <div className="mb-1 text-[12px] font-medium text-muted-foreground">URL 探针(返回 JSON;{"{rows,bar,value}"} 协议或任意 JSON)</div>
                {cfg.probes.map((p, i) => (
                  <div key={i} className="mb-1 flex items-center gap-1.5">
                    <input value={p.name} onChange={e => setCfg(c => ({ ...c, probes: c.probes.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))}
                      placeholder={t("名称")} className="w-28 shrink-0 rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring" />
                    <input value={p.url} onChange={e => setCfg(c => ({ ...c, probes: c.probes.map((x, j) => j === i ? { ...x, url: e.target.value } : x) }))}
                      placeholder="https://…/monitor"
                      className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring" />
                    <button title="移除" onClick={() => setCfg(c => ({ ...c, probes: c.probes.filter((_, j) => j !== i) }))}
                      className="rounded p-1 text-muted-foreground/60 hover:text-red-500">✕</button>
                  </div>
                ))}
                <button onClick={() => setCfg(c => ({ ...c, probes: [...c.probes, { name: "", url: "" }] }))}
                  className="rounded px-1.5 py-1 text-[12px] text-primary hover:bg-accent">{t("+ 添加探针")}</button>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2 text-[13px]">
              <button onClick={() => setCfgOpen(false)} className="rounded px-3 py-1.5 text-muted-foreground hover:bg-accent">{t("取消")}</button>
              <button onClick={saveCfg} className="rounded bg-primary px-3 py-1.5 text-primary-foreground hover:opacity-90">{t("保存")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
