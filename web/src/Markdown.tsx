/* 迷你 markdown 渲染(文件预览用):零依赖,块级状态机 + 内联 tokenizer,
   输出 React 元素——文本全走 React 转义,天然防注入,不引 marked/react-markdown。
   覆盖:标题/段落/围栏代码/引用/有序无序列表/GFM 表格/分隔线/行内 code·粗·斜·删·链接。 */
import React from "react";

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(!\[[^\]\n]*\]\([^)\s]+\))|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(src: string, img?: (u: string) => string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const tok = m[0], key = `i${m.index}`;
    if (tok.startsWith("`")) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**") || tok.startsWith("__")) out.push(<strong key={key} className="font-semibold">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("~~")) out.push(<s key={key} className="opacity-60">{tok.slice(2, -2)}</s>);
    else if (tok.startsWith("![")) {
      // 嵌入图(svg/png/…,经 <img> 渲染不执行脚本);相对路径由 resolveImg 换算成远端下载 URL
      const mm = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok)!;
      const src2 = img?.(mm[2]);
      out.push(src2
        ? <img key={key} src={src2} alt={mm[1]} title={mm[1]} loading="lazy" className="my-1 inline-block max-w-full rounded" />
        : mm[1]);
    }
    else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(/^https?:\/\//.test(mm[2])
        ? <a key={key} href={mm[2]} target="_blank" rel="noreferrer" className="text-primary hover:underline">{mm[1]}</a>
        : mm[1]);   // 相对链接(远端文件场景取不到),降级纯文本
    }
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export default function Markdown({ text, resolveImg }: { text: string; resolveImg?: (u: string) => string }) {
  const il = (s: string) => inline(s, resolveImg);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let key = 0;
  const nk = () => `b${key++}`;
  let i = 0;
  const H = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
  const HC = ["text-xl font-bold mt-5 mb-2.5", "text-lg font-bold mt-5 mb-2", "text-[15px] font-semibold mt-4 mb-1.5",
    "text-[14.5px] font-semibold mt-3 mb-1", "font-semibold mt-2.5", "font-semibold mt-2.5"];
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    if (ln.trim().startsWith("```")) {   // 围栏代码块
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(<pre key={nk()} className="my-2.5 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[12.5px] leading-relaxed">{buf.join("\n")}</pre>);
      continue;
    }
    if (/^\s*<svg/i.test(ln)) {   // 内联 svg 块:整段编码成 data URI 走 <img>(img 方式禁脚本/禁外链,零注入)
      const buf: string[] = [ln];
      i++;
      while (i < lines.length && !/<\/svg>/i.test(buf[buf.length - 1])) buf.push(lines[i++]);
      const svg = buf.join("\n");
      if (/<\/svg>/i.test(svg)) {
        out.push(<div key={nk()} className="my-3 overflow-x-auto text-center">
          <img src={`data:image/svg+xml,${encodeURIComponent(svg)}`} alt="" className="max-w-full" />
        </div>);
        continue;
      }
      // 未闭合:落到下面按普通段落处理
    }
    if (/^\s*<\/?(div|p|center)\b[^>]*>\s*$/i.test(ln)) { i++; continue; }   // 纯排版标签行(常与 svg 组合):不显示原文
    const h = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (h) {
      const Tag = H[h[1].length - 1];
      out.push(<Tag key={nk()} className={HC[h[1].length - 1]}>{il(h[2])}</Tag>);
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { out.push(<hr key={nk()} className="my-4 border-border" />); i++; continue; }
    if (ln.startsWith(">")) {   // 引用:连续行聚合成一段
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={nk()} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{il(buf.join(" "))}</blockquote>);
      continue;
    }
    if (ln.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {   // GFM 表格
      const cells = (r: string) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const head = cells(ln);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      out.push(<div key={nk()} className="my-2.5 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr>{head.map((c, j) => <th key={j} className="border border-border bg-muted px-2 py-1 text-left font-semibold">{il(c)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri} className="even:bg-muted/40">{r.map((c, j) => <td key={j} className="border border-border px-2 py-1 align-top">{il(c)}</td>)}</tr>)}</tbody>
        </table></div>);
      continue;
    }
    const isUl = /^\s*[-*+]\s+/.test(ln), isOl = /^\s*\d+[.)]\s+/.test(ln);
    if (isUl || isOl) {   // 列表:连续同类行聚合
      const items: string[] = [];
      while (i < lines.length && (isUl ? /^\s*[-*+]\s+/.test(lines[i]) : /^\s*\d+[.)]\s+/.test(lines[i])))
        items.push(lines[i++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
      const Tag = isUl ? "ul" : "ol";
      out.push(<Tag key={nk()} className={`${isUl ? "list-disc" : "list-decimal"} my-2 pl-6 [&>li]:my-0.5`}>{items.map((it, j) => <li key={j}>{il(it)}</li>)}</Tag>);
      continue;
    }
    const buf = [ln]; i++;   // 段落:吃到空行/特殊行
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(<p key={nk()} className="my-2">{il(buf.join(" "))}</p>);
  }
  return <div className="text-[13.5px] leading-relaxed">{out}</div>;
}
