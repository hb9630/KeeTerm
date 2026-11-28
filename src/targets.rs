//! 目标注册表:local(本机)+ ~/.ssh/config 别名(VSCode Remote 哲学)+ targets.toml 增强项。
//! 连接解析优先级:toml(显式 addr/user/pass)> ssh config;名字不存在时视为 addr 直连。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Entry {
    pub name: String,
    #[serde(default)]
    pub addr: String,      // 覆盖地址(空=按名字走 ssh config/本机)
    #[serde(default)]
    pub port: String,      // 端口(空=22)
    #[serde(default)]
    pub user: String,      // 覆盖用户(空=按名字走 ssh config)
    #[serde(default)]
    pub pass: String,      // 密码(SSH_ASKPASS 注入;不回传前端)
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub kind: String,      // ssh(默认)| local
    #[serde(default)]
    pub sort: i32,
}

#[derive(Debug, Clone, Default)]
pub struct SshHost {
    pub hostname: String,
    pub port: String,
    pub user: String,
    pub proxyjump: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetView {
    pub name: String,
    pub kind: String,        // local | ssh
    pub source: String,      // builtin | config | toml
    pub note: String,
    pub user: String,
    pub addr: String,        // 展示用:实际地址或别名
    #[serde(default)]
    pub port: String,
    pub has_pass: bool,
}

#[derive(Clone)]
pub struct Registry {
    pub toml_path: PathBuf,
    pub ssh_config: PathBuf,
}

impl Registry {
    pub fn new(toml_path: Option<PathBuf>, ssh_config: Option<PathBuf>) -> Self {
        Self {
            toml_path: toml_path.unwrap_or_else(|| {
                dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))
                    .join("keeterm")
                    .join("targets.toml")
            }),
            ssh_config: ssh_config
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".ssh").join("config")),
        }
    }

    pub fn load_toml_pub(&self) -> Vec<Entry> {
        self.load_toml()
    }

    fn load_toml(&self) -> Vec<Entry> {
        let s = match std::fs::read_to_string(&self.toml_path) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        #[derive(Deserialize, Default)]
        struct File {
            #[serde(default, rename = "target")]
            targets: Vec<Entry>,
        }
        toml::from_str::<File>(&s).map(|f| f.targets).unwrap_or_default()
    }

    pub fn save_toml(&self, entries: &[Entry]) -> Result<()> {
        #[derive(Serialize)]
        struct File<'a> {
            target: &'a [Entry],
        }
        if let Some(dir) = self.toml_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.toml_path, toml::to_string_pretty(&File { target: entries })?)?;
        Ok(())
    }

    /// ~/.ssh/config 解析(Host 别名 → 字段;通配/多模式行取单别名)
    pub fn ssh_hosts(&self) -> HashMap<String, SshHost> {
        let mut out: HashMap<String, SshHost> = HashMap::new();
        let mut aliases: Vec<String> = vec![];
        let mut files: Vec<PathBuf> = vec![self.ssh_config.clone()];
        let mut seen: Vec<PathBuf> = vec![];
        // Include 展开(一层足够)
        if let Ok(s) = std::fs::read_to_string(&self.ssh_config) {
            for line in s.lines() {
                let l = line.trim();
                let (k, v) = match l.split_once(char::is_whitespace) {
                    Some((k, v)) => (k.to_ascii_lowercase(), v.trim().to_string()),
                    None => continue,
                };
                if k == "include" && !v.is_empty() && seen.len() < 8 {
                    let p = if Path::new(&v).is_absolute() {
                        PathBuf::from(&v)
                    } else {
                        dirs::home_dir().unwrap_or_default().join(".ssh").join(&v)
                    };
                    if !seen.contains(&p) {
                        seen.push(p.clone());
                        files.push(p);
                    }
                }
            }
        }
        for f in files {
            let s = match std::fs::read_to_string(&f) {
                Ok(s) => s,
                Err(_) => continue,
            };
            for line in s.lines() {
                let l = line.trim();
                if l.is_empty() || l.starts_with('#') {
                    continue;
                }
                let (k, v) = match l.split_once(char::is_whitespace) {
                    Some((k, v)) => (k.to_ascii_lowercase(), v.trim().to_string()),
                    None => continue,
                };
                match k.as_str() {
                    "host" => {
                        aliases = v
                            .split_whitespace()
                            .filter(|a| !a.contains('*') && !a.contains('?') && !a.contains('!'))
                            .filter(|a| a.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
                            .map(String::from)
                            .collect();
                        for a in &aliases {
                            out.entry(a.clone()).or_default();
                        }
                    }
                    "hostname" | "port" | "user" | "proxyjump" => {
                        if !v.is_empty() {
                            for a in &aliases {
                                let h = out.entry(a.clone()).or_default();
                                match k.as_str() {
                                    "hostname" => h.hostname = v.clone(),
                                    "port" => h.port = v.clone(),
                                    "user" => h.user = v.clone(),
                                    _ => h.proxyjump = v.clone(),
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }

    /// 前端列表:local(置顶)+ toml 条目 + ssh config 别名(去重)
    pub fn list(&self) -> Vec<TargetView> {
        let mut out = vec![TargetView {
            name: "local".into(),
            kind: "local".into(),
            source: "builtin".into(),
            note: "本机".into(),
            user: String::new(),
            addr: String::new(),
            port: String::new(),
            has_pass: false,
        }];
        let cfg = self.ssh_hosts();
        let entries = self.load_toml();
        let mut names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
        for e in entries.iter().filter(|e| e.kind != "local") {
            out.push(TargetView {
                name: e.name.clone(),
                kind: "ssh".into(),
                source: "toml".into(),
                note: e.note.clone(),
                user: e.user.clone(),
                addr: if e.addr.is_empty() {
                    cfg.get(&e.name).map(|c| c.hostname.clone()).unwrap_or_default()
                } else {
                    e.addr.clone()
                },
                port: if e.port.is_empty() {
                    cfg.get(&e.name).map(|c| c.port.clone()).unwrap_or_default()
                } else {
                    e.port.clone()
                },
                has_pass: !e.pass.is_empty(),
            });
        }
        for (name, c) in &cfg {
            if names.contains(name) {
                continue;
            }
            names.push(name.clone());
            out.push(TargetView {
                name: name.clone(),
                kind: "ssh".into(),
                source: "config".into(),
                note: String::new(),
                user: c.user.clone(),
                addr: c.hostname.clone(),
                port: c.port.clone(),
                has_pass: false,
            });
        }
        // local 置顶,其余按名字排(toml 与 config 混排,不分组)
        let (first, rest) = out.split_at(1);
        let mut rest = rest.to_vec();
        rest.sort_by_key(|t| t.name.to_lowercase());
        let mut out = first.to_vec();
        out.extend(rest);
        out
    }

    /// 连接解析:名字 → (kind, 连接目标, user, pass)。名字是 local 或 toml/config 命中;
    /// 未命中视为裸地址(如 user@host:port 简写交给 ssh 自己解析)。
    pub fn resolve(&self, name: &str) -> Option<Entry> {
        if name == "local" {
            return Some(Entry { name: "local".into(), kind: "local".into(), ..Default::default() });
        }
        if let Some(e) = self.load_toml().into_iter().find(|e| e.name == name) {
            return Some(Entry { kind: "ssh".into(), ..e });
        }
        if let Some(c) = self.ssh_hosts().get(name) {
            // config 的 User 兜底(toml 未显式给时),终端是否交互问用户名以此为据
            return Some(Entry { name: name.into(), kind: "ssh".into(), user: c.user.clone(), ..Default::default() });
        }
        // 未知名字:当作地址直连(名字本身传给 ssh)
        Some(Entry { name: name.into(), kind: "ssh".into(), ..Default::default() })
    }

    // ---------- ssh config 的 Host 块级增删(agent API) ----------
    /// 按 Host 块分段:块="Host <别名>" 行起至下一个 Host 行止;块前紧邻的连续注释行
    /// 随块走(手工登记习惯是注释在 Host 上方)。零散行(空行/块外指令)各自成块原样保留。
    /// 单遍扫描+零散缓冲:注释行从缓冲划归后块,绝不重叠(重叠=join 后注释翻倍)。
    /// 多别名行(Host a b)不属于本机制的管辖,原样保留。
    fn ssh_config_blocks(&self) -> (Vec<String>, String) {
        let text = std::fs::read_to_string(&self.ssh_config).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        let is_host = |l: &str| {
            let t = l.trim();
            match t.split_once(char::is_whitespace) {
                Some((k, v)) => k.eq_ignore_ascii_case("host") && !v.is_empty() && !t.starts_with('#'),
                None => false,
            }
        };
        let mut blocks: Vec<String> = vec![];
        let mut loose: Vec<&str> = vec![];   // 下一个 Host 块之前的零散行
        let mut i = 0;
        while i < lines.len() {
            if is_host(lines[i]) {
                // 本块=Host 行起至下一个 Host 行止,但块尾若带注释(下块的手写注释被扫进来),
                // 剥离还给下块——否则 del 本块后注释残留、重写时还会翻倍
                let mut j = i + 1;
                while j < lines.len() && !is_host(lines[j]) { j += 1; }
                let mut end = j;
                while end > i + 1 && lines[end - 1].trim_start().starts_with('#') { end -= 1; }
                // loose 尾部连续注释同样划归本块前缀;之前的零散行自成块
                let mut cstart = loose.len();
                while cstart > 0 && loose[cstart - 1].trim_start().starts_with('#') { cstart -= 1; }
                let pre_s = if cstart > 0 { Some(loose[..cstart].join("\n")) } else { None };
                let mut blk: Vec<&str> = loose[cstart..].to_vec();
                blk.extend_from_slice(&lines[i..end]);
                if let Some(s) = pre_s { blocks.push(s); }
                blocks.push(blk.join("\n"));
                loose = lines[end..j].to_vec();   // 剥离的注释留给下一块
                i = j;
            } else {
                loose.push(lines[i]);
                i += 1;
            }
        }
        if !loose.is_empty() { blocks.push(loose.join("\n")); }
        (blocks, text)
    }

    fn block_host_name(block: &str) -> Option<String> {
        for l in block.lines() {
            let t = l.trim();
            if t.starts_with('#') { continue; }
            if let Some((k, v)) = t.split_once(char::is_whitespace) {
                if k.eq_ignore_ascii_case("host") {
                    let mut names = v.split_whitespace();
                    let first = names.next()?.to_string();
                    // 单别名块才可识别归属;多别名原样保留不参与增删
                    return if names.next().is_none() { Some(first) } else { None };
                }
            }
        }
        None
    }

    fn write_ssh_config(&self, blocks: &[String]) -> Result<(), String> {
        let mut out = blocks.join("\n");
        if !out.ends_with('\n') { out.push('\n'); }
        std::fs::write(&self.ssh_config, out).map_err(|e| e.to_string())
    }

    /// 增/改主机块(幂等:先剔同名旧块再追加)。note 进注释行。
    pub fn ssh_config_add(&self, name: &str, addr: &str, port: u16, user: &str, note: &str) -> Result<(), String> {
        if addr.trim().is_empty() { return Err("addr 不能为空".into()); }
        let (mut blocks, _) = self.ssh_config_blocks();
        blocks.retain(|b| Self::block_host_name(b).as_deref() != Some(name));
        let mut blk = String::new();
        if !note.trim().is_empty() { blk.push_str(&format!("# {}\n", note.trim())); }
        blk.push_str(&format!("Host {name}\n    HostName {}\n    Port {port}\n    User {}\n", addr.trim(), user.trim()));
        if let Some(last) = blocks.last() {
            if !last.trim().is_empty() { blk = format!("\n{blk}"); }
        }
        blocks.push(blk);
        self.write_ssh_config(&blocks)
    }

    /// 删主机块;返回是否真的剔除了(幂等,不存在不算错)
    pub fn ssh_config_del(&self, name: &str) -> Result<bool, String> {
        let (mut blocks, _) = self.ssh_config_blocks();
        let before = blocks.len();
        blocks.retain(|b| Self::block_host_name(b).as_deref() != Some(name));
        let removed = blocks.len() != before;
        if removed { self.write_ssh_config(&blocks)?; }
        Ok(removed)
    }
}
