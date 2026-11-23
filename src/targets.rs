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
                    .join("term-gateway")
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
}
