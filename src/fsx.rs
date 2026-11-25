//! 远端/容器文件 API(纯 exec 实现,零协议库):ls -U -p 流式分页 + stat 批量补大小 + cat 下载。
//! 语义与平台 term.py 一致(大目录亚秒分页;truncated 哨兵)。

use crate::exec;
use crate::targets::Entry;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Auth;
use crate::targets::Registry;

fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 在目标(或目标上的容器)执行:ctn 有值走引擎 exec,否则直跑
pub async fn run_on(entry: &Entry, ctn: &str, engine: &str, cmd: &str, timeout_s: u64) -> anyhow::Result<(i32, Vec<u8>)> {
    if ctn.is_empty() {
        return exec::run(entry, cmd, timeout_s).await;
    }
    let q = shq(ctn);
    let inner = format!("exec {q} sh -c {}", shq(cmd));
    let full = match engine {
        "docker" | "podman" => format!("{engine} {inner}"),
        _ => format!("command -v docker >/dev/null 2>&1 && docker {inner} || podman {inner}"),
    };
    // 容器命令包一层目标执行(local=本机 docker;ssh=远端)
    exec::run(entry, &full, timeout_s).await
}

fn err(msg: impl Into<String>) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, msg.into()).into_response()
}

macro_rules! need_auth {
    ($auth:expr, $headers:expr) => {
        if !$auth.check($headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    };
}

// ---------- GET /api/t/target/{target}/fs/home?ctn&engine ----------
#[derive(Deserialize)]
pub struct FsQuery {
    #[serde(default)] pub ctn: String,
    #[serde(default)] pub engine: String,
}

pub async fn fs_home(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(target): Path<String>,
    axum::extract::Query(q): axum::extract::Query<FsQuery>,
) -> Response {
    fs_home_inner(&reg, &auth, &headers, &target, &q.ctn, &q.engine).await
}

pub async fn fs_home_inner(reg: &Arc<Registry>, auth: &Arc<Auth>, headers: &HeaderMap, target: &str, ctn: &str, engine: &str) -> Response {
    need_auth!(auth, headers);
    let Some(entry) = reg.resolve(target) else { return StatusCode::NOT_FOUND.into_response() };
    if !exec::fs_unix(&entry) {
        return err("Windows 本机暂不支持文件浏览(远程目标不受影响)");
    }
    match run_on(&entry, ctn, engine, "cd && pwd", 20).await {
        Ok((0, out)) => {
            let home = String::from_utf8_lossy(&out).trim().lines().last().unwrap_or("/").to_string();
            axum::Json(serde_json::json!({ "home": home })).into_response()
        }
        Ok((_, out)) => err(format!("取家目录失败:{}", String::from_utf8_lossy(&out).trim())),
        Err(e) => err(format!("取家目录失败:{e}")),
    }
}

// ---------- GET /api/t/fs?target&ctn&engine&path&hidden&limit&offset ----------
#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)] pub ctn: String,
    #[serde(default)] pub engine: String,
    #[serde(default)] pub path: String,
    #[serde(default)] pub hidden: i64,
    #[serde(default)] pub limit: i64,
    #[serde(default)] pub offset: i64,
}

#[derive(Serialize)]
struct FileItem { name: String, size: u64 }

pub async fn fs_list(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(target): Path<String>,
    axum::extract::Query(q): axum::extract::Query<ListQuery>,
) -> Response {
    let (ctn, engine) = (q.ctn.clone(), q.engine.clone());
    fs_list_inner(&reg, &auth, &headers, &target, &ctn, &engine, q).await
}

#[allow(clippy::too_many_arguments)]
pub async fn fs_list_inner(reg: &Arc<Registry>, auth: &Arc<Auth>, headers: &HeaderMap, target: &str, ctn: &str, engine: &str, q: ListQuery) -> Response {
    need_auth!(auth, headers);
    let Some(entry) = reg.resolve(target) else { return StatusCode::NOT_FOUND.into_response() };
    if !exec::fs_unix(&entry) {
        return err("Windows 本机暂不支持文件浏览");
    }
    let path = if q.path.is_empty() { "/".to_string() } else { q.path };
    let qp = shq(&path);
    let mut cmd = format!("ls -U {} -p {qp}", if q.hidden != 0 { "-A" } else { "" });
    if q.offset > 0 {
        cmd.push_str(&format!(" | tail -n +{}", q.offset + 1));
    }
    if q.limit > 0 {
        cmd.push_str(&format!(" | head -n {}", q.limit + 1)); // 多取一条判 truncated
    }
    match run_on(&entry, ctn, engine, &cmd, 30).await {
        Ok((0, out)) => {
            let text = String::from_utf8_lossy(&out);
            let mut lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
            let truncated = q.limit > 0 && lines.len() as i64 > q.limit;
            if q.limit > 0 {
                lines.truncate(q.limit as usize);
            }
            let mut dirs: Vec<String> = vec![];
            let mut files: Vec<FileItem> = vec![];
            for l in lines {
                if let Some(d) = l.strip_suffix('/') {
                    dirs.push(d.to_string());
                } else {
                    files.push(FileItem { name: l.to_string(), size: 0 });
                }
            }
            if !files.is_empty() {
                let names = files.iter().take(600).map(|f| shq(&f.name)).collect::<Vec<_>>().join(" ");
                if let Ok((0, out)) = run_on(&entry, ctn, engine,
                    &format!("cd {qp} && stat -c '%s|%n' -- {names}"), 20).await {
                    for ln in String::from_utf8_lossy(&out).lines() {
                        if let Some((sz, name)) = ln.split_once('|') {
                            if let (Ok(sz), Some(f)) = (sz.parse::<u64>(), files.iter_mut().find(|f| f.name == name)) {
                                f.size = sz;
                            }
                        }
                    }
                }
            }
            dirs.sort_by_key(|d| d.to_lowercase());
            files.sort_by_key(|f| f.name.to_lowercase());
            if q.limit > 0 {
                axum::Json(serde_json::json!({ "dirs": dirs, "files": files, "truncated": truncated })).into_response()
            } else {
                axum::Json(serde_json::json!({ "dirs": dirs, "files": files })).into_response()
            }
        }
        Ok((_, out)) => err(format!("列目录失败:{}", String::from_utf8_lossy(&out).trim())),
        Err(e) => err(format!("列目录失败:{e}")),
    }
}

// ---------- GET /api/t/fs/download ----------
#[derive(Deserialize)]
pub struct DlQuery {
    pub path: String,
    #[serde(default)] pub ctn: String,
    #[serde(default)] pub engine: String,
    #[serde(default)] pub tar: String,   // =1:目录打包 tar.gz 流
}

pub async fn fs_download(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(target): Path<String>,
    axum::extract::Query(q): axum::extract::Query<DlQuery>,
) -> Response {
    let (ctn, engine) = (q.ctn.clone(), q.engine.clone());
    fs_download_inner(&reg, &auth, &headers, &target, &ctn, &engine, q).await
}

pub async fn fs_download_inner(reg: &Arc<Registry>, auth: &Arc<Auth>, headers: &HeaderMap, target: &str, ctn: &str, engine: &str, q: DlQuery) -> Response {
    need_auth!(auth, headers);
    let Some(entry) = reg.resolve(target) else { return StatusCode::NOT_FOUND.into_response() };
    // tar=1:目录打包(tar czf - 流式);否则 cat 单文件
    let (cmd, dname, timeout, forced_mime) = if q.tar == "1" {
        let name = q.path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("root").to_string();
        let parent = q.path[..q.path.len() - name.len()].trim_end_matches('/');
        let parent = if parent.is_empty() { "/" } else { parent };
        (format!("tar czf - -C {} {}", shq(parent), shq(&name)), format!("{name}.tar.gz"), 600, Some("application/gzip".to_string()))
    } else {
        (format!("cat {}", shq(&q.path)), q.path.rsplit('/').next().unwrap_or("file").to_string(), 600, None)
    };
    match run_on(&entry, ctn, engine, &cmd, timeout).await {
        Ok((0, out)) => {
            let name = dname;
            let mut r = Response::new(out.into());
            // 按扩展名给真实类型:pdf/图片的 blob URL 才能唤起浏览器内置预览
            //(svg 经 <img> 不执行脚本,html 预览走前端 sandbox iframe,均不吃注入)
            let mime = forced_mime.unwrap_or_else(|| mime_guess::from_path(&q.path).first_or_octet_stream().as_ref().to_string());
            r.headers_mut().insert("content-type", mime.parse().unwrap());
            r.headers_mut().insert(
                "content-disposition",
                format!("attachment; filename*=UTF-8''{}", urlencode(&name)).parse().unwrap(),
            );
            r
        }
        Ok((_, out)) => err(format!("读取失败:{}", String::from_utf8_lossy(&out).trim())),
        Err(e) => err(format!("读取失败:{e}")),
    }
}

// ---------- POST /api/t/fs/stat(预览自动刷新探针:批量取 mtime+size,单次 exec) ----------
#[derive(Deserialize)]
pub struct StatIn {
    pub paths: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
pub async fn fs_stat_inner(reg: &Arc<Registry>, auth: &Arc<Auth>, headers: &HeaderMap, target: &str, ctn: &str, engine: &str, body: StatIn) -> Response {
    need_auth!(auth, headers);
    let Some(entry) = reg.resolve(target) else { return StatusCode::NOT_FOUND.into_response() };
    if !exec::fs_unix(&entry) {
        return err("Windows 本机暂不支持文件浏览");
    }
    let paths: Vec<&String> = body.paths.iter().filter(|p| !p.is_empty() && !p.contains("..")).take(64).collect();
    if paths.is_empty() {
        return axum::Json(serde_json::json!({ "stats": {} })).into_response();
    }
    let cmd = format!("stat -c '%Y|%s|%n' -- {}", paths.iter().map(|p| shq(p)).collect::<Vec<_>>().join(" "));
    match run_on(&entry, ctn, engine, &cmd, 20).await {
        // 部分文件消失时 stat 退出码非 0,但 stdout 仍有幸存行:只按行解析不看成败
        Ok((_, out)) => {
            let mut stats = serde_json::Map::new();
            for ln in String::from_utf8_lossy(&out).lines() {
                let mut it = ln.splitn(3, '|');
                if let (Some(m), Some(s), Some(n)) = (it.next(), it.next(), it.next()) {
                    if let (Ok(m), Ok(s)) = (m.parse::<u64>(), s.parse::<u64>()) {
                        stats.insert(n.to_string(), serde_json::json!({ "m": m, "s": s }));
                    }
                }
            }
            axum::Json(serde_json::json!({ "stats": stats })).into_response()
        }
        Err(e) => err(format!("stat 失败:{e}")),
    }
}

pub async fn fs_stat(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(target): Path<String>,
    axum::Json(body): axum::Json<StatIn>,
) -> Response {
    fs_stat_inner(&reg, &auth, &headers, &target, "", "", body).await
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------- POST /api/t/fs/op ----------
#[derive(Deserialize)]
pub struct FsOp {
    #[serde(default)] pub ctn: String,
    #[serde(default)] pub engine: String,
    pub op: String,
    #[serde(default)] pub path: String,
    #[serde(default)] pub name: String,
    #[serde(default)] pub to: String,
    #[serde(default)] pub dir: String,
    #[serde(default)] pub data: String,
}

pub async fn fs_op(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(target): Path<String>,
    axum::extract::Query(q): axum::extract::Query<FsQuery>,
    axum::Json(req): axum::Json<FsOp>,
) -> Response {
    let mut req = req;
    if req.ctn.is_empty() { req.ctn = q.ctn.clone(); req.engine = q.engine.clone(); }
    fs_op_inner(&reg, &auth, &headers, &target, &q.ctn, &q.engine, req).await
}

pub async fn fs_op_inner(reg: &Arc<Registry>, auth: &Arc<Auth>, headers: &HeaderMap, target: &str, ctn: &str, engine: &str, mut req: FsOp) -> Response {
    need_auth!(auth, headers);
    let Some(entry) = reg.resolve(target) else { return StatusCode::NOT_FOUND.into_response() };
    if req.ctn.is_empty() { req.ctn = ctn.to_string(); req.engine = engine.to_string(); }
    if !exec::fs_unix(&entry) {
        return err("Windows 本机暂不支持文件操作");
    }
    let base = {
        let b = if req.path.is_empty() { req.dir.clone() } else { req.path.clone() };
        b.trim_end_matches('/').to_string()
    };
    let cmd = match req.op.as_str() {
        "mkdir" => format!("mkdir -p {}", shq(&format!("{}/{}", base, req.name))),
        "touch" => format!("touch {}", shq(&format!("{}/{}", base, req.name))),
        "rename" => format!("mv -- {} {}", shq(&req.path), shq(&req.to)),
        "delete" => format!("rm -rf -- {}", shq(&req.path)),
        "copy" => format!("cp -a -- {} {}", shq(&req.path), shq(&req.to)),
        "upload" => {
            // 分块写(整文件塞命令行会 E2BIG;复用 save 的 write_chunks)
            let dest = format!("{}/{}", base, req.name);
            return match write_chunks(&entry, &req.ctn, &req.engine, &dest, &req.data).await {
                Ok(()) => axum::Json(serde_json::json!({ "ok": true })).into_response(),
                Err(e) => axum::Json(serde_json::json!({ "error": e })).into_response(),
            };
        }
        _ => return (StatusCode::BAD_REQUEST, format!("未知操作 {}", req.op)).into_response(),
    };
    match run_on(&entry, &req.ctn, &req.engine, &cmd, 300).await {
        Ok((0, _)) => axum::Json(serde_json::json!({ "ok": true })).into_response(),
        Ok((_, out)) => axum::Json(serde_json::json!({ "error": format!("操作失败:{}", String::from_utf8_lossy(&out).trim()) })).into_response(),
        Err(e) => axum::Json(serde_json::json!({ "error": format!("操作失败:{e}") })).into_response(),
    }
}

// ---------- POST fs/save:编辑器整文件写入(base64 分块追加,单参数不超 MAX_ARG_STRLEN) ----------
#[derive(Deserialize)]
pub struct SaveIn {
    pub path: String,
    pub content: String,
}

/// 分块写远端文件(base64 块追加再解码落位):save 与 upload 共用,
/// 单参数不超 MAX_ARG_STRLEN(整文件塞命令行会 E2BIG)
async fn write_chunks(entry: &Entry, ctn: &str, engine: &str, path: &str, b64: &str) -> Result<(), String> {
    let tmp = format!("/tmp/tgw-save-{}-{:x}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let mut first = true;
    for chunk in b64.as_bytes().chunks(96_000) {
        let c = std::str::from_utf8(chunk).unwrap_or("");
        let redirect = if first { ">" } else { ">>" };
        let op = format!("printf '%s' {} {redirect} {}", shq(c), shq(&tmp));
        match run_on(entry, ctn, engine, &op, 60).await {
            Ok((0, _)) => {}
            Ok((_, out)) => {
                let _ = run_on(entry, ctn, engine, &format!("rm -f {}", shq(&tmp)), 10).await;
                return Err(format!("写入失败:{}", String::from_utf8_lossy(&out).trim()));
            }
            Err(e) => return Err(format!("写入失败:{e}")),
        }
        first = false;
    }
    let fin = format!("base64 -d {} > {} && rm -f {}", shq(&tmp), shq(path), shq(&tmp));
    match run_on(entry, ctn, engine, &fin, 60).await {
        Ok((0, _)) => Ok(()),
        Ok((_, out)) => Err(format!("保存失败:{}", String::from_utf8_lossy(&out).trim())),
        Err(e) => Err(format!("保存失败:{e}")),
    }
}

pub async fn fs_save_inner(reg: &Arc<Registry>, auth: &Arc<Auth>, headers: &HeaderMap, target: &str, ctn: &str, engine: &str, body: SaveIn) -> Response {
    need_auth!(auth, headers);
    let Some(entry) = reg.resolve(target) else { return StatusCode::NOT_FOUND.into_response() };
    if body.path.is_empty() || body.path.contains("..") {
        return (StatusCode::BAD_REQUEST, "路径不合法").into_response();
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(body.content.as_bytes());
    match write_chunks(&entry, ctn, engine, &body.path, &b64).await {
        Ok(()) => axum::Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => err(e),
    }
}

pub async fn fs_save(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(target): Path<String>,
    axum::Json(body): axum::Json<SaveIn>,
) -> Response {
    fs_save_inner(&reg, &auth, &headers, &target, "", "", body).await
}

// ---------- 路径式容器路由:/api/t/target/{t}/ctn/{c}/fs…(Explorer apiBase 纯路径约定) ----------
#[derive(Deserialize)]
pub struct CtnPath {
    pub target: String,
    pub ctn: String,
    #[serde(default)] pub engine: String,
}

/// ctn 段允许 "容器@引擎"(apiBase 纯路径约定:engine 不能走 query,会和 Explorer 拼的 ?path 打架)
fn split_ctn(p: &CtnPath) -> (String, String, String) {
    match p.ctn.split_once('@') {
        Some((c, e)) => (p.target.clone(), c.to_string(), e.to_string()),
        None => (p.target.clone(), p.ctn.clone(), p.engine.clone()),
    }
}

pub async fn ctn_fs_home(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(p): Path<CtnPath>,
) -> Response {
    let (t, c, e) = split_ctn(&p);
    fs_home_inner(&reg, &auth, &headers, &t, &c, &e).await
}
pub async fn ctn_fs_list(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(p): Path<CtnPath>,
    axum::extract::Query(q): axum::extract::Query<ListQuery>,
) -> Response {
    let (t, c, e) = split_ctn(&p);
    fs_list_inner(&reg, &auth, &headers, &t, &c, &e, q).await
}
pub async fn ctn_fs_download(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(p): Path<CtnPath>,
    axum::extract::Query(q): axum::extract::Query<DlQuery>,
) -> Response {
    let (t, c, e) = split_ctn(&p);
    fs_download_inner(&reg, &auth, &headers, &t, &c, &e, q).await
}
pub async fn ctn_fs_op(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(p): Path<CtnPath>,
    axum::Json(req): axum::Json<FsOp>,
) -> Response {
    let (t, c, e) = split_ctn(&p);
    fs_op_inner(&reg, &auth, &headers, &t, &c, &e, req).await
}
pub async fn ctn_fs_save(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(p): Path<CtnPath>,
    axum::Json(body): axum::Json<SaveIn>,
) -> Response {
    let (t, c, e) = split_ctn(&p);
    fs_save_inner(&reg, &auth, &headers, &t, &c, &e, body).await
}
pub async fn ctn_fs_stat(
    State((reg, auth)): State<(Arc<Registry>, Arc<Auth>)>,
    headers: HeaderMap,
    Path(p): Path<CtnPath>,
    axum::Json(body): axum::Json<StatIn>,
) -> Response {
    let (t, c, e) = split_ctn(&p);
    fs_stat_inner(&reg, &auth, &headers, &t, &c, &e, body).await
}
