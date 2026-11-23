/* 自包含基础件:cn / api / mini toast(自 ieoss @shared 剥离,零外部依赖) */
import { useEffect, useState } from "react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (r.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    throw new Error("未登录");
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch { try { msg = (await r.text()) || msg; } catch { /* */ } }
    throw new Error(msg);
  }
  return r.json();
}

/* mini toast:右下角浮条,3s 自消 */
let push: ((msg: string, err?: boolean) => void) | null = null;
export function toast(msg: string, err = false) {
  push?.(msg, err) ?? console.warn(err ? "ERR:" : "", msg);
}

export function Toaster() {
  const [items, setItems] = useState<{ id: number; msg: string; err?: boolean }[]>([]);
  useEffect(() => {
    push = (msg, err) => {
      const id = Date.now() + Math.random();
      setItems(v => [...v, { id, msg, err }]);
      setTimeout(() => setItems(v => v.filter(i => i.id !== id)), 3000);
    };
    return () => { push = null; };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {items.map(i => (
        <div key={i.id} className={`rounded-md border px-3 py-2 text-[13px] shadow-lg ${i.err ? "border-red-300 bg-red-50 text-red-600" : "border-border bg-card text-foreground"}`}>
          {i.msg}
        </div>
      ))}
    </div>
  );
}
