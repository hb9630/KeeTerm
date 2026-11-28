//! 监控面板(自 keeper 右栏移植):mon.toml 声明要监控的主机(target 名)与 URL 探针。
//! 15s 一轮——主机走 exec 通道采 CPU/内存/存储/GPU(keeper rows 协议),探针走本机 curl 拉 JSON
//! ({rows,bar,value} 协议或任意 JSON 前端拍平);hist 环形 480 点 ≈ 2h 曲线。

use crate::exec;
use crate::targets::Registry;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Deserialize, Clone, serde::Serialize)]
pub struct MonHost {
    pub name: String,
}
#[derive(Deserialize, Clone, serde::Serialize)]
pub struct MonProbe {
    pub name: String,
    pub url: String,
}
#[derive(Deserialize, Default)]
struct MonFile {
    #[serde(default, rename = "host")]
    hosts: Vec<MonHost>,
    #[serde(default, rename = "probe")]
    probes: Vec<MonProbe>,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct Row {
    pub k: String,
    pub v: String,
}
#[derive(serde::Serialize, Clone, Default)]
pub struct HostStat {
    pub online: bool,
    pub rows: Vec<Row>,
    pub hist: Vec<u8>,
}
#[derive(serde::Serialize, Clone)]
pub struct ProbeStat {
    pub name: String,
    pub url: String,
    pub online: bool,
    pub ts: u64,
    pub data: Option<serde_json::Value>,
    pub hist: Vec<f64>,
}
#[derive(Default)]
pub struct Mon {
    pub hosts: HashMap<String, HostStat>,
    pub probes: Vec<ProbeStat>,
}

pub static MON: OnceLock<Arc<Mutex<Mon>>> = OnceLock::new();
const HIST: usize = 480;

pub fn mon_path() -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_default().join("keeterm").join("mon.toml")
}

fn load() -> MonFile {
    std::fs::read_to_string(mon_path())
        .ok()
        .and_then(|s| toml::from_str(&s).ok())
        .unwrap_or_default()
}

/// 指标采集命令(目标机 Linux):CPU 两次采样、内存、存储(root 分区)、GPU(有 nvidia-smi 才出)。
/// LC_ALL=C:目标机中文 locale 会把 free/df 的行标签列名汉化,awk 匹配失效。
const METRIC_CMD: &str = r#"export LC_ALL=C; vmstat 1 2 | awk 'END{printf "CPU %d%%\n", 100-$15}'; free -b | awk '/^Mem:/{printf "内存 %d%% · %.0fG\n", $3*100/$2, $2/1073741824}'; df -h / | awk 'NR==2{printf "存储 %s · %s\n", $5, $2}'; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits | head -1 | awk -F', ' '{if ($2 ~ /^\[/) printf "GPU %s%%\n", $1; else printf "GPU %s%% · %s/%s MiB\n", $1, $2, $3}'; true"#;

fn parse_rows(out: &[u8]) -> Option<Vec<Row>> {
    let mut rows = vec![];
    for ln in String::from_utf8_lossy(out).lines() {
        let ln = ln.trim();
        if let Some((k, v)) = ln.split_once(' ') {
            let v = v.trim();
            if !k.is_empty() && !v.is_empty() {
                rows.push(Row { k: k.into(), v: v.into() });
            }
        }
    }
    if rows.is_empty() { None } else { Some(rows) }
}

/// 探针曲线采点(框架协议):highlights[0].v 数值 > value > bar.pct
fn probe_value(d: &Option<serde_json::Value>) -> Option<f64> {
    let d = d.as_ref()?;
    if let Some(v) = d.get("highlights").and_then(|h| h.get(0)).and_then(|h| h.get("v")) {
        if let Some(n) = v.as_f64().or_else(|| v.as_str().and_then(num_prefix)) { return Some(n); }
    }
    d.get("value").and_then(|v| v.as_f64())
        .or_else(|| d.get("bar")?.get("pct")?.as_f64())
}

/// 字串开头的数值("1.0 张/时"→1.0;"42%"→42);"lazy · since…"这类非数值开头返回 None
fn num_prefix(s: &str) -> Option<f64> {
    let t = s.trim_start();
    let end = t.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(t.len());
    let head = &t[..end];
    if head.is_empty() || !head.chars().any(|c| c.is_ascii_digit()) { return None; }
    head.parse::<f64>().ok()
}

async fn tick_hosts(reg: &Arc<Registry>, cfg: &MonFile, mon: &Arc<Mutex<Mon>>) {
    // 配置里已移除的主机清出状态(只 insert 不删的话卡片永远不消失)
    {
        let mut m = mon.lock().unwrap();
        m.hosts.retain(|k, _| cfg.hosts.iter().any(|h| &h.name == k));
    }
    // 并发采集(每台 vmstat 1s+,串行 N 台=N 秒起步;配置保存后的即时轮尤其要快)
    let mut futs = vec![];
    for h in &cfg.hosts {
        let Some(entry) = reg.resolve(&h.name) else { continue };
        let name = h.name.clone();
        let mon2 = mon.clone();
        futs.push(async move {
            let mut st = mon2.lock().unwrap().hosts.get(&name).cloned().unwrap_or_default();
            match exec::run(&entry, METRIC_CMD, 20).await {
                Ok((0, out)) => {
                    st.rows = parse_rows(&out).unwrap_or_default();
                    st.online = !st.rows.is_empty();
                    if let Some(cpu) = st.rows.iter().find(|r| r.k == "CPU")
                        .and_then(|r| r.v.trim().trim_end_matches('%').trim().parse::<u8>().ok())
                    {
                        st.hist.push(cpu);
                        if st.hist.len() > HIST { st.hist.remove(0); }
                    }
                }
                _ => { st.online = false; st.rows.clear(); }
            }
            mon2.lock().unwrap().hosts.insert(name.clone(), st);
        });
    }
    futures_util::future::join_all(futs).await;
}

async fn tick_probes(cfg: &MonFile, mon: &Arc<Mutex<Mon>>) {
    let mut out = vec![];
    for p in &cfg.probes {
        let mut c = tokio::process::Command::new("curl");
        c.args(["-sS", "-k", "-m", "10", &p.url])   // -k:内网自签证书场景(海报 monitor 等)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let (online, data) = match c.output().await {
            Ok(o) if o.status.success() => {
                let v = serde_json::from_slice::<serde_json::Value>(&o.stdout).ok();
                (v.is_some(), v)
            }
            _ => (false, None),
        };
        let mut hist = mon.lock().unwrap()
            .probes.iter().find(|x| x.url == p.url)
            .map(|x| x.hist.clone()).unwrap_or_default();
        if let Some(v) = probe_value(&data) {
            hist.push(v);
            if hist.len() > HIST { hist.remove(0); }
        }
        out.push(ProbeStat {
            name: p.name.clone(),
            url: p.url.clone(),
            online,
            ts: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            data,
            hist,
        });
    }
    mon.lock().unwrap().probes = out;
}

/// 采集循环:常驻 tokio 任务,mon.toml 热改生效(每轮现读)
pub fn start(reg: Arc<Registry>) -> Arc<Mutex<Mon>> {
    let mon = Arc::new(Mutex::new(Mon::default()));
    let m2 = mon.clone();
    tokio::spawn(async move {
        loop {
            let cfg = load();
            tick_hosts(&reg, &cfg, &m2).await;
            tick_probes(&cfg, &m2).await;
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
    mon
}

/// 立即采一轮(配置保存后调用,不等 15s 周期)
pub async fn tick_now(reg: &Arc<Registry>) {
    let Some(mon) = MON.get() else { return };
    let cfg = load();
    tick_hosts(reg, &cfg, mon).await;
    tick_probes(&cfg, mon).await;
}

// ---------- 配置读写(前端 + 号入口) ----------
#[derive(Deserialize)]
pub struct CfgIn {
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub probes: Vec<MonProbe>,
}

pub fn cfg_get() -> serde_json::Value {
    let c = load();
    serde_json::json!({
        "hosts": c.hosts.iter().map(|h| h.name.clone()).collect::<Vec<_>>(),
        "probes": c.probes.iter().map(|p| serde_json::json!({ "name": p.name, "url": p.url })).collect::<Vec<_>>(),
    })
}

pub fn cfg_save(body: &CfgIn) -> Result<(), String> {
    let mut hosts: Vec<MonHost> = vec![];
    for h in &body.hosts {
        let n = h.trim();
        if n.is_empty() || hosts.iter().any(|x| x.name == n) { continue; }
        if !n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            return Err(format!("主机名不合法:{n}"));
        }
        hosts.push(MonHost { name: n.into() });
    }
    let mut probes: Vec<MonProbe> = vec![];
    for p in &body.probes {
        let n = p.name.trim();
        let u = p.url.trim();
        if n.is_empty() && u.is_empty() { continue; }
        if n.is_empty() || u.is_empty() {
            return Err("探针名称与 URL 都不能为空".into());
        }
        if !u.starts_with("http://") && !u.starts_with("https://") {
            return Err(format!("URL 需以 http(s):// 开头:{u}"));
        }
        probes.push(MonProbe { name: n.into(), url: u.into() });
    }
    #[derive(serde::Serialize)]
    struct File<'a> {
        host: &'a [MonHost],
        probe: &'a [MonProbe],
    }
    std::fs::write(mon_path(), toml::to_string_pretty(&File { host: &hosts, probe: &probes }).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// 增量添加(agent 快捷入口 POST /api/t/mon/add):与既有配置合并去重
/// (host 按名、probe 按 url),不动其他条目;校验规则与 cfg_save 一致
pub fn cfg_add(body: &CfgIn) -> Result<usize, String> {
    let mut cur = load();
    let mut added = 0usize;
    for h in &body.hosts {
        let n = h.trim();
        if n.is_empty() || cur.hosts.iter().any(|x| x.name == n) { continue; }
        if !n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            return Err(format!("主机名不合法:{n}"));
        }
        cur.hosts.push(MonHost { name: n.into() });
        added += 1;
    }
    for p in &body.probes {
        let n = p.name.trim();
        let u = p.url.trim();
        if n.is_empty() && u.is_empty() { continue; }
        if n.is_empty() || u.is_empty() {
            return Err("探针名称与 URL 都不能为空".into());
        }
        if !u.starts_with("http://") && !u.starts_with("https://") {
            return Err(format!("URL 需以 http(s):// 开头:{u}"));
        }
        if cur.probes.iter().any(|x| x.url == u) { continue; }
        cur.probes.push(MonProbe { name: n.into(), url: u.into() });
        added += 1;
    }
    #[derive(serde::Serialize)]
    struct File<'a> {
        host: &'a [MonHost],
        probe: &'a [MonProbe],
    }
    std::fs::write(mon_path(), toml::to_string_pretty(&File { host: &cur.hosts, probe: &cur.probes }).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(added)
}

/// 增量删(agent 快捷入口 POST /api/t/mon/del):host 按名、probe 按 url,不在的不算错
pub fn cfg_del(hosts: &[String], probes: &[String]) -> Result<usize, String> {
    let mut cur = load();
    let before = cur.hosts.len() + cur.probes.len();
    cur.hosts.retain(|h| !hosts.iter().any(|x| x.trim() == h.name));
    cur.probes.retain(|p| !probes.iter().any(|u| u.trim() == p.url));
    let removed = before - cur.hosts.len() - cur.probes.len();
    #[derive(serde::Serialize)]
    struct File<'a> {
        host: &'a [MonHost],
        probe: &'a [MonProbe],
    }
    std::fs::write(mon_path(), toml::to_string_pretty(&File { host: &cur.hosts, probe: &cur.probes }).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn probe_value_protocol_priority() {
        // highlights[0] 优先(value/bar 都让位)
        assert_eq!(probe_value(&Some(json!({"highlights":[{"k":"a","v":"1.5 x"}],"value":9,"bar":{"pct":80}}))), Some(1.5));
        // 纯数值字符串 / 数值型 / 百分号
        assert_eq!(probe_value(&Some(json!({"highlights":[{"k":"a","v":"42%"}]}))), Some(42.0));
        assert_eq!(probe_value(&Some(json!({"highlights":[{"k":"a","v":7}]}))), Some(7.0));
        // 非数值开头 → 落到 value/bar
        assert_eq!(probe_value(&Some(json!({"highlights":[{"k":"a","v":"lazy · since 11-23"}],"value":3}))), Some(3.0));
        // 仅 value / 仅 bar.pct
        assert_eq!(probe_value(&Some(json!({"value":12}))), Some(12.0));
        assert_eq!(probe_value(&Some(json!({"title":"x","sum":"24723/50000","rows":[{"k":"a","v":"b"}]}))), None);
        assert_eq!(probe_value(&None), None);
    }

    #[test]
    fn num_prefix_cases() {
        assert_eq!(num_prefix("1.0 张/时 · p50 40.0s"), Some(1.0));
        assert_eq!(num_prefix("42%"), Some(42.0));
        assert_eq!(num_prefix("  7 "), Some(7.0));
        assert_eq!(num_prefix("lazy · since 11-23 18:55"), None);
        assert_eq!(num_prefix("0 提/0 过"), Some(0.0));
        assert_eq!(num_prefix(""), None);
    }
}
