use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, MutexGuard};

type HmacSha256 = Hmac<Sha256>;

static RUNNING_PID: AtomicU32 = AtomicU32::new(0);

lazy_static::lazy_static!(
    static ref CURRENT_CHILD: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
);

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
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C");
        c.arg(program);
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

    let status = child
        .wait()
        .await
        .map_err(|e| format!("等待命令完成失败: {}", e))?;

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

fn resolve_deploy_script(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // 开发模式: src-tauri/scripts/deploy-cos.js
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("deploy-cos.js");
    if dev_path.is_file() {
        return Ok(dev_path);
    }

    // 打包模式: resource_dir/scripts/deploy-cos.js
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {}", e))?
        .join("scripts")
        .join("deploy-cos.js");
    if resource_path.is_file() {
        return Ok(resource_path);
    }

    Err(format!(
        "未找到 deploy-cos.js 脚本，已检查:\n  开发: {}\n  打包: {}",
        dev_path.display(),
        resource_path.display()
    ))
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

    run_shell_command(&app, parts[0], &parts[1..], &project_path, event).await
        .map_err(|e| format!("Build 失败: {}", e))?;

    let dist_path = project_path.join("dist");
    if !dist_path.is_dir() {
        return Err("Build 完成但未找到 dist 目录".to_string());
    }

    let _ = app.emit(event, "[1/5] Build 完成 ✓");

    // ===== Step 2: Upload to COS via Node script =====
    let _ = app.emit(event, "[2/5] 正在上传文件到 COS...");

    let script_path = resolve_deploy_script(&app)?;

    let cos_params = serde_json::json!({
        "SecretId": params.cos_secret_id,
        "SecretKey": params.cos_secret_key,
        "Region": params.cos_region,
        "Bucket": params.cos_bucket,
        "distPath": dist_path.to_string_lossy()
    });

    run_shell_command(
        &app,
        "node",
        &[
            script_path.to_str().ok_or("脚本路径包含非法字符")?,
            &cos_params.to_string(),
        ],
        &project_path,
        event,
    )
    .await
    .map_err(|e| format!("COS 上传失败: {}", e))?;

    let _ = app.emit(event, "[2/5] COS 上传完成 ✓");

    if let Some(domain) = params.cdn_domain.as_deref().filter(|d| !d.is_empty()) {
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
            read_text_file
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
