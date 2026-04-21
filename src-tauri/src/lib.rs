use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, PhysicalPosition, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, MutexGuard, Semaphore};
use tokio_util::sync::CancellationToken;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

static RUNNING_PID: AtomicU32 = AtomicU32::new(0);

lazy_static::lazy_static!(
    static ref CURRENT_CHILD: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    /// 正在进行的部署任务的 CancellationToken 注册表，key = deploy_id
    static ref DEPLOY_CANCEL_TOKENS: Arc<Mutex<HashMap<String, CancellationToken>>> =
        Arc::new(Mutex::new(HashMap::new()));
);

/// 取消正在进行的部署任务（由前端点击删除日志时调用）
#[tauri::command]
async fn cancel_deploy(deploy_id: String) -> Result<(), String> {
    let mut map = DEPLOY_CANCEL_TOKENS.lock().await;
    if let Some(token) = map.remove(&deploy_id) {
        token.cancel();
        Ok(())
    } else {
        // 任务可能已经完成，不视为错误
        Ok(())
    }
}

fn resolve_project_root() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {}", e))?;
    let exe_dir = exe
        .parent()
        .ok_or("无法获取 exe 所在目录")?
        .to_path_buf();
    let candidates = [
        exe_dir.clone(),
        exe_dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| exe_dir.clone()),
        exe_dir
            .parent()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| exe_dir.clone()),
        exe_dir
            .parent()
            .and_then(|p| p.parent().and_then(|p| p.parent().map(|p| p.to_path_buf())))
            .unwrap_or_else(|| exe_dir.clone()),
    ];
    for dir in &candidates {
        let script = dir.join("wx-ribao.py");
        if script.is_file() {
            return dir.canonicalize().map_err(|e| {
                format!("项目根目录无效: {} ({})", dir.display(), e)
            });
        }
    }
    Err(format!(
        "未找到 wx-ribao.py，已检查: exe 同级及向上 3 级目录（如 {}）",
        exe_dir.display()
    ))
}

#[tauri::command]
async fn run_wx_ribao(app: AppHandle, params: Vec<String>) -> Result<(), String> {
    let python_path = std::env::var("PYTHON_PATH")
        .unwrap_or_else(|_| "python".to_string());

    {
        let child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if child_lock.is_some() {
            return Err("已有脚本正在运行，请先停止".to_string());
        }
    }

    let project_root = resolve_project_root()?;
    let script_path = project_root.join("wx-ribao.py");
    if !script_path.is_file() {
        return Err(format!(
            "未找到脚本: {}，请确保 wx-ribao.py 在项目根目录",
            script_path.display()
        ));
    }
    let script_path = script_path
        .canonicalize()
        .map_err(|e| format!("脚本路径无效: {}", e))?;

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path);
    for param in &params {
        cmd.arg(param);
    }
    cmd.current_dir(&project_root);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动 Python 进程失败: {}", e))?;

    if let Some(pid) = child.id() {
        RUNNING_PID.store(pid, Ordering::SeqCst);
    }

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        *child_lock = Some(child);
    }

    let app_stdout = app.clone();
    let app_stderr = app.clone();

    let stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stdout.emit("python-stdout", line);
        }
    });

    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stderr.emit("python-stderr", line);
        }
    });

    let status = {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if let Some(mut c) = child_lock.take() {
            RUNNING_PID.store(0, Ordering::SeqCst);
            drop(child_lock);
            c.wait().await.map_err(|e| format!("等待进程失败: {}", e))?
        } else {
            return Err("进程已被停止".to_string());
        }
    };

    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    if !status.success() {
        return Err(format!("Python 脚本执行失败，退出码: {:?}", status.code()));
    }

    Ok(())
}

#[tauri::command]
async fn kill_python_script() -> Result<(), String> {
    let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
    if let Some(child) = child_lock.as_mut() {
        child.kill().await.map_err(|e| format!("停止进程失败: {}", e))?;
        *child_lock = None;
        RUNNING_PID.store(0, Ordering::SeqCst);
        Ok(())
    } else {
        Err("没有正在运行的脚本".to_string())
    }
}

#[tauri::command]
async fn capture_qr_code(app: AppHandle) -> Result<String, String> {
    let python_path =
        std::env::var("PYTHON_PATH").unwrap_or_else(|_| "python".to_string());

    {
        let child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if child_lock.is_some() {
            return Err("已有脚本正在运行，请先停止".to_string());
        }
    }

    let project_root = resolve_project_root()?;
    let script_path = project_root.join("wx-ribao.py");
    if !script_path.is_file() {
        return Err(format!(
            "未找到脚本: {}，请确保 wx-ribao.py 在项目根目录",
            script_path.display()
        ));
    }
    let script_path = script_path
        .canonicalize()
        .map_err(|e| format!("脚本路径无效: {}", e))?;

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path);
    cmd.arg("--step").arg("qr");
    cmd.current_dir(&project_root);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Python 进程失败: {}", e))?;

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        *child_lock = Some(child);
    }

    let app_stdout = app.clone();
    let app_stderr = app.clone();

    let _stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stdout.emit("python-stdout", line);
        }
    });

    let _stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stderr.emit("python-stderr", line);
        }
    });

    {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if let Some(mut c) = child_lock.take() {
            drop(child_lock);
            let status = c
                .wait().await
                .map_err(|e| format!("等待进程失败: {}", e))?;
            if !status.success() {
                return Err(format!("Python 脚本执行失败，退出码: {:?}", status.code()));
            }
        } else {
            return Err("进程已被停止".to_string());
        }
    }

    let qr_result = std::fs::read_to_string(project_root.join("qr_result_tmp.json"))
        .ok()
        .filter(|content| !content.trim().is_empty());

    if let Some(qr) = qr_result {
        Ok(qr)
    } else {
        Err("未找到二维码结果，请查看运行日志".to_string())
    }
}

// ==================== 腾讯云 CDN API (TC3-HMAC-SHA256) ====================

fn sha256_hash(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC can take key of any size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

async fn call_tencent_cdn_api(
    secret_id: &str,
    secret_key: &str,
    action: &str,
    payload: &str,
) -> Result<serde_json::Value, String> {
    let host = "cdn.tencentcloudapi.com";
    let service = "cdn";
    let version = "2018-06-06";
    let now = Utc::now();
    let timestamp = now.timestamp();
    let date = now.format("%Y-%m-%d").to_string();

    let hashed_payload = hex::encode(sha256_hash(payload.as_bytes()));
    let canonical_request = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{host}\n\ncontent-type;host\n{hashed_payload}"
    );

    let credential_scope = format!("{date}/{service}/tc3_request");
    let hashed_canonical = hex::encode(sha256_hash(canonical_request.as_bytes()));
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{hashed_canonical}"
    );

    let secret_date = hmac_sha256(
        format!("TC3{secret_key}").as_bytes(),
        date.as_bytes(),
    );
    let secret_service = hmac_sha256(&secret_date, service.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hex::encode(hmac_sha256(&secret_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders=content-type;host, Signature={signature}"
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("https://{host}"))
        .header("Authorization", &authorization)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", host)
        .header("X-TC-Action", action)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("X-TC-Version", version)
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("CDN API 请求失败: {}", e))?;

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 CDN API 响应失败: {}", e))?;

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 CDN API 响应失败: {}", e))?;

    if let Some(response) = json.get("Response") {
        if response.get("Error").is_some() {
            return Err(format!(
                "CDN API 返回错误: {}",
                serde_json::to_string_pretty(response).unwrap_or_default()
            ));
        }
    }

    Ok(json)
}

// ==================== 部署命令 ====================

#[derive(serde::Deserialize)]
struct DeployParams {
    deploy_id: String,
    project_dir: String,
    build_command: Option<String>,
    cos_secret_id: String,
    cos_secret_key: String,
    cos_region: String,
    cos_bucket: String,
    cdn_secret_id: String,
    cdn_secret_key: String,
    cdn_domain: Option<String>,
}

async fn run_shell_command(
    app: &AppHandle,
    program: &str,
    args: &[&str],
    cwd: &std::path::Path,
    event_name: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let needs_shell = matches!(program, "npm" | "npx" | "pnpm" | "yarn");

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = if needs_shell {
            let mut c = Command::new("cmd");
            c.arg("/C");
            c.arg(program);
            c
        } else {
            Command::new(program)
        };
        for arg in args {
            c.arg(arg);
        }
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(program);
        for arg in args {
            c.arg(arg);
        }
        c
    };

    cmd.env("NODE_OPTIONS", "--openssl-legacy-provider");
    cmd.current_dir(cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动命令 {} 失败: {}", program, e))?;

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    let app_out = app.clone();
    let event_out = event_name.to_string();
    let stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(event_out.as_str(), &line);
        }
    });

    let app_err = app.clone();
    let event_err = event_name.to_string();
    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(event_err.as_str(), &line);
        }
    });

    // 轮询等待子进程退出，同时监听取消信号
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(format!("等待命令完成失败: {}", e)),
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                // 让 child 彻底收尾
                let _ = child.wait().await;
                return Err("已取消".to_string());
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(150)) => {}
        }
    };

    let timeout = tokio::time::Duration::from_secs(5);
    let _ = tokio::time::timeout(timeout, stdout_handle).await;
    let _ = tokio::time::timeout(timeout, stderr_handle).await;

    if !status.success() {
        return Err(format!(
            "命令执行失败，退出码: {:?}",
            status.code()
        ));
    }

    Ok(())
}

fn strip_unc_prefix(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\?\") {
        std::path::PathBuf::from(&s[4..])
    } else {
        p.to_path_buf()
    }
}

// ==================== 腾讯云 COS 原生上传 (v5 签名) ====================

fn sha1_hex(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn hmac_sha1_hex(key: &[u8], data: &[u8]) -> String {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

/// 按 COS 规范对 URL 路径做 encode：保留 `/`，其余字符用 %XX
fn cos_encode_path(key: &str) -> String {
    key.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// 生成 COS PUT Object 请求签名（只签 host 头，v5 算法）
/// 参考：https://cloud.tencent.com/document/product/436/7778
///
/// 注意：COS 服务端验签用的是 **URL 解码后** 的原始路径与 header，所以
/// `UriPathname` 与 `http_headers` 必须用原始字符串，而不是 URL-encoded 后的。
fn build_cos_authorization(
    secret_id: &str,
    secret_key: &str,
    method: &str, // lowercase, e.g. "put"
    key: &str,    // 对象 key，如 "assets/main.js"，无前导 /
    host: &str,
) -> String {
    let now = Utc::now().timestamp();
    let start = now - 60;
    let end = now + 3600;
    let key_time = format!("{};{}", start, end);

    let sign_key = hmac_sha1_hex(secret_key.as_bytes(), key_time.as_bytes());

    let uri_pathname = format!("/{}", key);
    let header_list = "host";
    let http_headers = format!("host={}", host);

    let http_string = format!("{}\n{}\n\n{}\n", method, uri_pathname, http_headers);
    let string_to_sign = format!(
        "sha1\n{}\n{}\n",
        key_time,
        sha1_hex(http_string.as_bytes())
    );

    let signature = hmac_sha1_hex(sign_key.as_bytes(), string_to_sign.as_bytes());

    format!(
        "q-sign-algorithm=sha1&q-ak={sid}&q-sign-time={kt}&q-key-time={kt}&q-header-list={hl}&q-url-param-list=&q-signature={sig}",
        sid = secret_id,
        kt = key_time,
        hl = header_list,
        sig = signature,
    )
}

/// 判断错误是否值得重试（网络错误 / 5xx / 429 重试，其它不重试）
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

async fn upload_single_file_to_cos(
    client: &reqwest::Client,
    secret_id: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    key: &str,
    file_path: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    let body = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?;

    let host = format!("{}.cos.{}.myqcloud.com", bucket, region);
    let url = format!("https://{}/{}", host, cos_encode_path(key));
    let content_type = mime_guess::from_path(key)
        .first_or_octet_stream()
        .to_string();

    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err: String = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if cancel.is_cancelled() {
            return Err("已取消".to_string());
        }

        // 每次重试都重新签名，避免 key_time 过期
        let authorization = build_cos_authorization(secret_id, secret_key, "put", key, &host);

        let send_fut = client
            .put(&url)
            .header("Authorization", &authorization)
            .header("Content-Type", &content_type)
            .body(body.clone())
            .send();

        let send_result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("已取消".to_string()),
            r = send_fut => r,
        };

        match send_result {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return Ok(());
                }
                let text = resp.text().await.unwrap_or_default();
                last_err = format!("COS 返回 {}: {}", status, text);
                if !is_retryable_status(status) {
                    return Err(last_err);
                }
            }
            Err(e) => {
                last_err = format!("HTTP 请求失败: {}", e);
            }
        }

        if attempt < MAX_ATTEMPTS {
            let delay_ms = 500u64 * (1u64 << (attempt - 1)); // 500ms, 1s
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("已取消".to_string()),
                _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {}
            }
        }
    }

    Err(format!("重试 {} 次后仍失败: {}", MAX_ATTEMPTS, last_err))
}

async fn upload_dir_to_cos(
    app: &AppHandle,
    event: &str,
    secret_id: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    dist_path: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if secret_id.trim().is_empty()
        || secret_key.trim().is_empty()
        || bucket.trim().is_empty()
        || region.trim().is_empty()
    {
        return Err("COS 凭证不完整：请检查 SecretId / SecretKey / Bucket / Region".to_string());
    }

    let mut files: Vec<(std::path::PathBuf, String)> = Vec::new();
    for entry in walkdir::WalkDir::new(dist_path) {
        let entry = entry.map_err(|e| format!("扫描目录失败: {}", e))?;
        if entry.file_type().is_file() {
            let abs = entry.path().to_path_buf();
            let rel = abs
                .strip_prefix(dist_path)
                .map_err(|e| format!("路径处理失败: {}", e))?;
            let key = rel.to_string_lossy().replace('\\', "/");
            files.push((abs, key));
        }
    }

    let total = files.len();
    if total == 0 {
        return Err("dist 目录为空，没有可上传的文件".to_string());
    }
    let _ = app.emit(event, format!("发现 {} 个文件待上传", total));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let concurrency = 8usize;
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let done_counter = Arc::new(AtomicU32::new(0));

    let mut handles = Vec::with_capacity(total);
    for (abs_path, key) in files {
        let sem = semaphore.clone();
        let client = client.clone();
        let secret_id = secret_id.to_string();
        let secret_key = secret_key.to_string();
        let bucket = bucket.to_string();
        let region = region.to_string();
        let app = app.clone();
        let event = event.to_string();
        let counter = done_counter.clone();
        let cancel = cancel.clone();

        let handle = tokio::spawn(async move {
            if cancel.is_cancelled() {
                return Err("已取消".to_string());
            }
            let _permit = sem.acquire().await.map_err(|e| format!("并发控制失败: {}", e))?;
            upload_single_file_to_cos(
                &client,
                &secret_id,
                &secret_key,
                &bucket,
                &region,
                &key,
                &abs_path,
                &cancel,
            )
            .await
            .map_err(|e| format!("上传 {} 失败: {}", key, e))?;

            let done = counter.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit(
                event.as_str(),
                format!("  [{}/{}] ✓ {}", done, total, key),
            );
            Ok::<(), String>(())
        });
        handles.push(handle);
    }

    let mut errors: Vec<String> = Vec::new();
    let mut cancelled_count: usize = 0;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if e.contains("已取消") {
                    cancelled_count += 1;
                } else {
                    errors.push(e);
                }
            }
            Err(e) => errors.push(format!("任务调度失败: {}", e)),
        }
    }

    // 如果是用户主动取消，返回统一的取消错误
    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    let _ = cancelled_count; // 未取消时忽略

    if !errors.is_empty() {
        const MAX_SHOWN: usize = 5;
        let shown = errors.len().min(MAX_SHOWN);
        let head = errors[..shown].join("\n");
        let remaining = errors.len().saturating_sub(shown);
        let summary = if remaining > 0 {
            format!("{} 个文件上传失败。前 {} 条错误:\n{}\n... 另有 {} 条省略", errors.len(), shown, head, remaining)
        } else {
            format!("{} 个文件上传失败:\n{}", errors.len(), head)
        };
        return Err(summary);
    }
    Ok(())
}

#[tauri::command]
async fn run_build_and_deploy(app: AppHandle, params: DeployParams) -> Result<(), String> {
    let project_path = std::path::PathBuf::from(&params.project_dir);

    if !project_path.is_dir() {
        return Err(format!("目录不存在: {}", params.project_dir));
    }
    if !project_path.join("package.json").is_file() {
        return Err("目标目录中未找到 package.json".to_string());
    }

    let event: String = format!("deploy-log-{}", params.deploy_id);
    let event = event.as_str();

    // 注册取消 token
    let cancel = CancellationToken::new();
    {
        let mut map = DEPLOY_CANCEL_TOKENS.lock().await;
        map.insert(params.deploy_id.clone(), cancel.clone());
    }

    // 包装：无论成败都记得清理 token
    let result = run_build_and_deploy_inner(&app, event, &params, &project_path, &cancel).await;

    {
        let mut map = DEPLOY_CANCEL_TOKENS.lock().await;
        map.remove(&params.deploy_id);
    }

    result
}

async fn run_build_and_deploy_inner(
    app: &AppHandle,
    event: &str,
    params: &DeployParams,
    project_path: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    // ===== Step 1: Build =====
    let _ = app.emit(event, "[1/5] 正在执行 build 命令...");

    let build_cmd = params
        .build_command
        .as_deref()
        .unwrap_or("npm run build");
    let parts: Vec<&str> = build_cmd.split_whitespace().collect();
    if parts.is_empty() {
        return Err("build 命令不能为空".to_string());
    }

    run_shell_command(app, parts[0], &parts[1..], project_path, event, cancel)
        .await
        .map_err(|e| {
            if e == "已取消" {
                e
            } else {
                format!("Build 失败: {}", e)
            }
        })?;

    let dist_path = project_path.join("dist");
    if !dist_path.is_dir() {
        return Err("Build 完成但未找到 dist 目录".to_string());
    }

    let _ = app.emit(event, "[1/5] Build 完成 ✓");

    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    // ===== Step 2: Upload to COS (native Rust, no Node.js required) =====
    let _ = app.emit(event, "[2/5] 正在上传文件到 COS...");

    let clean_dist = strip_unc_prefix(&dist_path);
    upload_dir_to_cos(
        app,
        event,
        &params.cos_secret_id,
        &params.cos_secret_key,
        &params.cos_bucket,
        &params.cos_region,
        &clean_dist,
        cancel,
    )
    .await
    .map_err(|e| {
        if e == "已取消" {
            e
        } else {
            format!("COS 上传失败: {}", e)
        }
    })?;

    let _ = app.emit(event, "[2/5] COS 上传完成 ✓");

    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    if let Some(domain) = params.cdn_domain.as_deref()
        .map(|d| d.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/'))
        .filter(|d| !d.is_empty())
    {
        // ===== Step 3: Purge URL Cache =====
        let _ = app.emit(event, "[3/5] 正在刷新 URL 缓存...");

        let purge_url_payload = serde_json::json!({
            "Urls": [format!("http://{domain}/"), format!("https://{domain}/")]
        })
        .to_string();

        call_tencent_cdn_api(
            &params.cdn_secret_id,
            &params.cdn_secret_key,
            "PurgeUrlsCache",
            &purge_url_payload,
        )
        .await?;

        let _ = app.emit(event, "[3/5] URL 缓存刷新完成 ✓");

        // ===== Step 4: Purge Directory Cache =====
        let _ = app.emit(event, "[4/5] 正在刷新目录缓存...");

        let purge_dir_payload = serde_json::json!({
            "Paths": [format!("http://{domain}/"), format!("https://{domain}/")],
            "FlushType": "flush"
        })
        .to_string();

        call_tencent_cdn_api(
            &params.cdn_secret_id,
            &params.cdn_secret_key,
            "PurgePathCache",
            &purge_dir_payload,
        )
        .await?;

        let _ = app.emit(event, "[4/5] 目录缓存刷新完成 ✓");

        // ===== Step 5: Preheat URL =====
        let _ = app.emit(event, "[5/5] 正在预热 URL...");

        let preheat_payload = serde_json::json!({
            "Urls": [format!("http://{domain}/"), format!("https://{domain}/")],
            "Area": "mainland"
        })
        .to_string();

        call_tencent_cdn_api(
            &params.cdn_secret_id,
            &params.cdn_secret_key,
            "PushUrlsCache",
            &preheat_payload,
        )
        .await?;

        let _ = app.emit(event, "[5/5] URL 预热完成 ✓");
    } else {
        let _ = app.emit(event, "[3-5/5] 未配置 CDN 域名，跳过 CDN 刷新和预热 ✓");
    }

    let _ = app.emit(event, "🎉 全部部署流程完成！");

    Ok(())
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|e| format!("读取文件失败: {} ({})", path, e))
}

// ==================== SSH 远程命令执行 ====================

#[derive(serde::Deserialize)]
struct SshServer {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct SshResult {
    host: String,
    name: String,
    success: bool,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

#[derive(serde::Serialize, Clone)]
struct SshProgress {
    host: String,
    status: String,
    message: String,
}

fn run_ssh_single(server: &SshServer, command: &str) -> SshResult {
    let addr = format!("{}:{}", server.host, server.port);
    let tcp = match std::net::TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| {
            format!("{}:{}", server.host, server.port)
                .parse()
                .unwrap()
        }),
        std::time::Duration::from_secs(10),
    ) {
        Ok(s) => s,
        Err(e) => {
            return SshResult {
                host: server.host.clone(),
                name: String::new(),
                success: false,
                stdout: String::new(),
                stderr: format!("连接失败: {}", e),
                exit_code: None,
            };
        }
    };

    let mut sess = match ssh2::Session::new() {
        Ok(s) => s,
        Err(e) => {
            return SshResult {
                host: server.host.clone(),
                name: String::new(),
                success: false,
                stdout: String::new(),
                stderr: format!("创建 SSH 会话失败: {}", e),
                exit_code: None,
            };
        }
    };

    sess.set_tcp_stream(tcp);
    if let Err(e) = sess.handshake() {
        return SshResult {
            host: server.host.clone(),
            name: String::new(),
            success: false,
            stdout: String::new(),
            stderr: format!("SSH 握手失败: {}", e),
            exit_code: None,
        };
    }

    let auth_result = if server.auth_type == "key" {
        if let Some(key_path) = &server.private_key_path {
            sess.userauth_pubkey_file(
                &server.username,
                None,
                std::path::Path::new(key_path),
                server.password.as_deref(),
            )
        } else {
            Err(ssh2::Error::from_errno(ssh2::ErrorCode::Session(-1)))
        }
    } else {
        sess.userauth_password(
            &server.username,
            server.password.as_deref().unwrap_or(""),
        )
    };

    if let Err(e) = auth_result {
        return SshResult {
            host: server.host.clone(),
            name: String::new(),
            success: false,
            stdout: String::new(),
            stderr: format!("认证失败: {}", e),
            exit_code: None,
        };
    }

    let mut channel = match sess.channel_session() {
        Ok(c) => c,
        Err(e) => {
            return SshResult {
                host: server.host.clone(),
                name: String::new(),
                success: false,
                stdout: String::new(),
                stderr: format!("创建通道失败: {}", e),
                exit_code: None,
            };
        }
    };

    if let Err(e) = channel.exec(command) {
        return SshResult {
            host: server.host.clone(),
            name: String::new(),
            success: false,
            stdout: String::new(),
            stderr: format!("执行命令失败: {}", e),
            exit_code: None,
        };
    }

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    use std::io::Read;
    let _ = channel.read_to_string(&mut stdout_buf);
    let _ = channel.stderr().read_to_string(&mut stderr_buf);

    let _ = channel.wait_close();
    let exit_code = channel.exit_status().ok();
    let success = exit_code == Some(0);

    SshResult {
        host: server.host.clone(),
        name: String::new(),
        success,
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code,
    }
}

#[tauri::command]
async fn execute_ssh_commands(
    app: AppHandle,
    servers: Vec<SshServer>,
    command: String,
    session_id: String,
) -> Result<Vec<SshResult>, String> {
    let event_name = format!("ssh-progress-{}", session_id);
    let mut results = Vec::new();

    for server in &servers {
        let _ = app.emit(
            event_name.as_str(),
            SshProgress {
                host: server.host.clone(),
                status: "connecting".to_string(),
                message: format!("正在连接 {}...", server.host),
            },
        );

        let result = {
            let s = SshServer {
                host: server.host.clone(),
                port: server.port,
                username: server.username.clone(),
                auth_type: server.auth_type.clone(),
                password: server.password.clone(),
                private_key_path: server.private_key_path.clone(),
            };
            let cmd = command.clone();
            tokio::task::spawn_blocking(move || run_ssh_single(&s, &cmd))
                .await
                .map_err(|e| format!("任务执行失败: {}", e))?
        };

        let status = if result.success { "success" } else { "error" };
        let _ = app.emit(
            event_name.as_str(),
            SshProgress {
                host: server.host.clone(),
                status: status.to_string(),
                message: if result.success {
                    "执行完成".to_string()
                } else {
                    result.stderr.clone()
                },
            },
        );

        results.push(result);
    }

    Ok(results)
}

#[tauri::command]
async fn test_ssh_connection(server: SshServer) -> Result<String, String> {
    let result = tokio::task::spawn_blocking(move || run_ssh_single(&server, "echo ok"))
        .await
        .map_err(|e| format!("测试失败: {}", e))?;

    if result.success {
        Ok("连接成功".to_string())
    } else {
        Err(result.stderr)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            run_wx_ribao,
            kill_python_script,
            capture_qr_code,
            run_build_and_deploy,
            cancel_deploy,
            read_text_file,
            execute_ssh_commands,
            test_ssh_connection
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            if let Some(monitor) = window.current_monitor().ok().flatten() {
                let screen = monitor.size();
                let scale = monitor.scale_factor();
                let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(1000, 700));
                let x = ((screen.width as f64 - win_size.width as f64) / 2.0) as i32;
                let y = (screen.height as f64 / scale - win_size.height as f64 / scale - 48.0) as i32;
                let _ = window.set_position(PhysicalPosition::new(
                    (x as f64 * scale) as i32,
                    (y as f64 * scale) as i32,
                ));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
