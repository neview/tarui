import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Alert, useAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OperationLogButton } from "@/components/OperationLog";
import { logOperation } from "@/utils/operationLog";
import { GlassCard, MiniField, glassInner, type DeployStatus } from "./ui";
import {
  H5Card,
  H5_COMPOSITE_KEY,
  H5_DEFAULT_CONFIG,
  H5_DIST_DIR,
  H5_ENV_KEY,
  H5_LABEL,
  H5_PROJECT_KEY,
  loadH5Config,
  saveH5Config,
  type H5Config,
} from "./h5Deploy";
import {
  MangoCard,
  MANGO_ENVIRONMENTS,
  MANGO_PROJECTS,
  MANGO_TARGETS,
  defaultMangoConfig,
  loadMangoConfig,
  saveMangoConfig,
  type MangoConfig,
  type MangoEnvConfig,
  type MangoTarget,
} from "./mangoDeploy";
import {
  FolderOpen,
  Rocket,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Settings2,
  Eraser,
  Import,
  FileDown,
  Plus,
  Trash2,
  X,
  RotateCw,
  KeyRound,
  ShieldCheck,
} from "lucide-react";

// ==================== Data Model ====================

interface EnvConfig {
  buildCommand: string;
  cosRegion: string;
  cosBucket: string;
  cdnDomain: string;
}

/** 一个可部署项目：唯一标识 + 展示名 + 本地目录 + 各环境配置 */
interface ProjectConfig {
  key: string;
  label: string;
  dir: string;
  envs: Record<string, EnvConfig>;
}

/** 只存放非敏感配置；腾讯云密钥在系统凭证管理器里，不进 localStorage */
interface AllConfig {
  projects: ProjectConfig[];
}

/** 后端返回的密钥配置状态，密钥本身永远不会回传前端 */
interface CredentialStatus {
  configured: boolean;
  secret_id_hint: string;
}

/** 总后台不在这里：它是微前端三产物结构，走 mangoDeploy 的内置卡片 */
const DEFAULT_PROJECTS = [
  { key: "agent", label: "代理后台" },
  { key: "order", label: "网页接单后台" },
];

/** 旧版配置里项目目录存放在 global 上的字段名 */
const LEGACY_DIR_FIELD: Record<string, string> = {
  mango: "mangoDir",
  agent: "agentDir",
  order: "orderDir",
};

const ENVIRONMENTS = [
  { key: "prod", label: "正式环境", color: "from-emerald-500/20 to-teal-500/20", dot: "bg-emerald-500" },
  { key: "test", label: "测试环境", color: "from-amber-500/20 to-orange-500/20", dot: "bg-amber-500" },
  { key: "backup", label: "备用正式环境", color: "from-violet-500/20 to-purple-500/20", dot: "bg-violet-500" },
] as const;

const STORAGE_KEY = "weixin-deploy-config-v4";
/** v3 及更早版本把密钥明文存在 localStorage 里，读取后必须迁移并删除 */
const LEGACY_STORAGE_KEYS = ["weixin-deploy-config-v3", "weixin-deploy-config-v2"];
const CONFIG_VERSION = 4;

const LOG_PAGE = "weixin";
const LOG_PAGE_LABEL = "微信部署";

function defaultEnvConfig(): EnvConfig {
  return { buildCommand: "npm run build", cosRegion: "", cosBucket: "", cdnDomain: "" };
}

function defaultEnvs(): Record<string, EnvConfig> {
  const envs: Record<string, EnvConfig> = {};
  for (const e of ENVIRONMENTS) envs[e.key] = defaultEnvConfig();
  return envs;
}

function defaultProjects(): ProjectConfig[] {
  return DEFAULT_PROJECTS.map((p) => ({ ...p, dir: "", envs: defaultEnvs() }));
}

/**
 * 解析配置对象，同时兼容三种写法：
 * - v4/v3：projects 为对象或数组，每项含 label / dir / envs
 * - v2：projects[key] 直接是环境表，目录放在 global.xxxDir
 *
 * 旧版本 global 上的 secretId / secretKey 一律忽略，密钥由 migrateLegacySecrets 单独处理。
 */
function parseConfig(raw: any): AllConfig | null {
  if (!raw || typeof raw !== "object" || !raw.projects) return null;
  const g = raw.global ?? {};

  const entries: [string, any][] = Array.isArray(raw.projects)
    ? raw.projects.filter((p: any) => p?.key).map((p: any) => [String(p.key), p])
    : Object.entries(raw.projects);

  const projects: ProjectConfig[] = [];
  for (const [key, value] of entries) {
    if (!key || !value || typeof value !== "object") continue;
    const rawEnvs = value.envs && typeof value.envs === "object" ? value.envs : value;
    const envs = defaultEnvs();
    for (const e of ENVIRONMENTS) {
      const src = rawEnvs[e.key];
      if (!src || typeof src !== "object") continue;
      envs[e.key] = {
        buildCommand: src.buildCommand ?? "",
        cosRegion: src.cosRegion ?? "",
        cosBucket: src.cosBucket ?? "",
        cdnDomain: src.cdnDomain ?? "",
      };
    }
    projects.push({
      key,
      label: value.label || DEFAULT_PROJECTS.find((p) => p.key === key)?.label || key,
      dir: value.dir || g[LEGACY_DIR_FIELD[key]] || "",
      envs,
    });
  }

  if (projects.length === 0) {
    projects.push(
      ...defaultProjects().map((p) => ({ ...p, dir: g[LEGACY_DIR_FIELD[p.key]] || "" }))
    );
  }

  return { projects };
}

/** 序列化为文件/存储格式，不含任何密钥 */
function serializeConfig(config: AllConfig) {
  const projects: Record<string, { label: string; dir: string; envs: Record<string, EnvConfig> }> = {};
  for (const p of config.projects) {
    projects[p.key] = { label: p.label, dir: p.dir, envs: p.envs };
  }
  return { version: CONFIG_VERSION, projects };
}

function loadAllConfig(): AllConfig {
  for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = parseConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {}
  }
  return { projects: defaultProjects() };
}

function saveAllConfig(config: AllConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeConfig(config)));
}

/**
 * 一次性迁移：把旧版本明文存在 localStorage 里的腾讯云密钥搬进系统凭证管理器，
 * 然后删除旧记录。返回是否搬迁了密钥。
 *
 * 注意 localStorage 落盘在 WebView 的 leveldb 里，删除只保证应用不再读到，
 * 磁盘上的历史文件需要用 scripts/purge-webview-storage.ps1 清理。
 */
async function migrateLegacySecrets(config: AllConfig): Promise<boolean> {
  let secretId = "";
  let secretKey = "";
  const staleKeys: string[] = [];

  for (const key of LEGACY_STORAGE_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    staleKeys.push(key);
    if (secretId && secretKey) continue;
    try {
      const g = JSON.parse(raw)?.global ?? {};
      const id = typeof g.secretId === "string" ? g.secretId.trim() : "";
      const sk = typeof g.secretKey === "string" ? g.secretKey.trim() : "";
      if (id && sk) {
        secretId = id;
        secretKey = sk;
      }
    } catch {}
  }

  if (staleKeys.length === 0) return false;

  // 先确保新版配置已落盘，再删旧键，避免中途失败丢掉项目配置
  saveAllConfig(config);

  let migrated = false;
  if (secretId && secretKey) {
    const existing = await invoke<CredentialStatus>("get_tencent_credentials_status");
    if (!existing.configured) {
      await invoke("save_tencent_credentials", { secretId, secretKey });
      migrated = true;
    }
  }

  for (const key of staleKeys) localStorage.removeItem(key);
  return migrated;
}

// ==================== Deploy Session ====================

interface DeploySession {
  id: string;
  compositeKey: string;
  projectKey: string;
  envKey: string;
  label: string;
  logs: string[];
  status: "running" | "success" | "error";
}

let deployCounter = 0;

/** 一次部署所需的全部入参，模板项目和内置的 H5 / 总后台都归一到这个结构 */
interface DeployRequest {
  compositeKey: string;
  projectKey: string;
  envKey: string;
  label: string;
  projectDir: string;
  buildCommand: string;
  distDir?: string;
  /** 多产物上传目标；给了就忽略 distDir */
  targets?: MangoTarget[];
  cosRegion: string;
  cosBucket: string;
  cdnDomain: string;
}

// ==================== Main Component ====================

export default function Weixin() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [config, setConfig] = useState<AllConfig>(loadAllConfig);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [sessions, setSessions] = useState<DeploySession[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, DeployStatus>>({});
  const [collapseAll, setCollapseAll] = useState(0);
  const cancelledIdsRef = useRef<Set<string>>(new Set());

  // 密钥状态由后端给出；输入框内容只在提交前留在内存里，不写 localStorage
  const [credStatus, setCredStatus] = useState<CredentialStatus>({ configured: false, secret_id_hint: "" });
  const [secretIdInput, setSecretIdInput] = useState("");
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [savingSecrets, setSavingSecrets] = useState(false);

  // H5 的配置独立存储，不进模板配置，也不参与导入导出
  const [h5Config, setH5Config] = useState<H5Config>(loadH5Config);

  // 两个总后台同理，各自一份独立存储
  const [mangoConfigs, setMangoConfigs] = useState<Record<string, MangoConfig>>(() =>
    Object.fromEntries(MANGO_PROJECTS.map((p) => [p.key, loadMangoConfig(p.storageKey)]))
  );

  useEffect(() => { saveAllConfig(config); }, [config]);
  useEffect(() => { saveH5Config(h5Config); }, [h5Config]);
  useEffect(() => {
    for (const p of MANGO_PROJECTS) {
      const cfg = mangoConfigs[p.key];
      if (cfg) saveMangoConfig(p.storageKey, cfg);
    }
  }, [mangoConfigs]);

  const configRef = useRef(config);
  configRef.current = config;

  // useAlert 每次渲染都会返回新的函数引用，所以这里不能把它们放进依赖，
  // 用 ref 保证「迁移 + 读取密钥状态」在整个生命周期里只跑一次
  const alertRef = useRef({ showSuccess, showError });
  alertRef.current = { showSuccess, showError };
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    (async () => {
      try {
        const migrated = await migrateLegacySecrets(configRef.current);
        setCredStatus(await invoke<CredentialStatus>("get_tencent_credentials_status"));
        if (migrated) {
          alertRef.current.showSuccess("已把腾讯云密钥迁移到系统凭证管理器，并清除了浏览器存储中的明文副本");
          logOperation({
            page: LOG_PAGE,
            pageLabel: LOG_PAGE_LABEL,
            action: "迁移腾讯云密钥",
            status: "success",
            detail: "密钥已移入系统凭证管理器，localStorage 中的旧明文记录已删除",
          });
        }
      } catch (err) {
        alertRef.current.showError(`读取密钥配置失败: ${err}`);
      }
    })();
  }, []);

  const runningKeys = sessions.filter((s) => s.status === "running").map((s) => s.compositeKey);

  const handleSaveSecrets = async () => {
    setSavingSecrets(true);
    try {
      const status = await invoke<CredentialStatus>("save_tencent_credentials", {
        secretId: secretIdInput,
        secretKey: secretKeyInput,
      });
      setCredStatus(status);
      setSecretIdInput("");
      setSecretKeyInput("");
      showSuccess("密钥已保存到系统凭证管理器");
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "保存腾讯云密钥",
        status: "success",
        detail: `SecretId：${status.secret_id_hint}`,
      });
    } catch (err) {
      showError(`保存失败: ${err}`);
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "保存腾讯云密钥",
        status: "error",
        detail: `保存失败: ${err}`,
      });
    } finally {
      setSavingSecrets(false);
    }
  };

  const handleDeleteSecrets = async () => {
    const ok = await confirmDialog("确定从系统凭证管理器中删除腾讯云密钥吗？删除后需要重新填写才能部署。", {
      title: "删除密钥",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await invoke("delete_tencent_credentials");
      setCredStatus({ configured: false, secret_id_hint: "" });
      showSuccess("密钥已删除");
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "删除腾讯云密钥",
        status: "info",
        detail: "已从系统凭证管理器中移除",
      });
    } catch (err) {
      showError(`删除失败: ${err}`);
    }
  };

  const updateProject = (projectKey: string, field: "label" | "dir", value: string) => {
    setConfig((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.key === projectKey ? { ...p, [field]: value } : p)),
    }));
  };

  const updateEnv = (projectKey: string, envKey: string, field: keyof EnvConfig, value: string) => {
    setConfig((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.key === projectKey
          ? { ...p, envs: { ...p.envs, [envKey]: { ...(p.envs[envKey] ?? defaultEnvConfig()), [field]: value } } }
          : p
      ),
    }));
  };

  const handleSelectDir = async (projectKey: string) => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) updateProject(projectKey, "dir", selected as string);
  };

  const addProject = () => {
    setConfig((prev) => {
      let index = prev.projects.length + 1;
      while (prev.projects.some((p) => p.key === `project${index}`)) index++;
      const created: ProjectConfig = {
        key: `project${index}`,
        label: `新项目 ${index}`,
        dir: "",
        envs: defaultEnvs(),
      };
      return { ...prev, projects: [...prev.projects, created] };
    });
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「添加项目」",
      status: "info",
      detail: "新增一个部署项目",
    });
  };

  const removeProject = async (projectKey: string) => {
    const target = config.projects.find((p) => p.key === projectKey);
    if (!target) return;
    const ok = await confirmDialog(`确定删除「${target.label}」及其全部环境配置吗？`, {
      title: "删除项目",
      kind: "warning",
    });
    if (!ok) return;
    setConfig((prev) => ({ ...prev, projects: prev.projects.filter((p) => p.key !== projectKey) }));
    setSessions((prev) => prev.filter((s) => s.projectKey !== projectKey));
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「删除项目」",
      status: "info",
      detail: `删除项目：${target.label}`,
    });
  };

  const removeSession = useCallback((id: string) => {
    let shouldCancel: { id: string; compositeKey: string } | null = null;
    setSessions((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target && target.status === "running") {
        shouldCancel = { id, compositeKey: target.compositeKey };
      }
      return prev.filter((s) => s.id !== id);
    });
    if (shouldCancel) {
      const { id: cancelId, compositeKey } = shouldCancel;
      cancelledIdsRef.current.add(cancelId);
      invoke("cancel_deploy", { deployId: cancelId }).catch(() => {});
      setStatusMap((m) => ({ ...m, [compositeKey]: "idle" }));
    }
  }, []);

  const rerunSession = useCallback(
    (session: DeploySession) => {
      const isRunning = sessions.some(
        (s) => s.compositeKey === session.compositeKey && s.status === "running"
      );
      if (isRunning) {
        showError("该环境已有正在运行的部署任务");
        return;
      }
      if (session.projectKey === H5_PROJECT_KEY) {
        handleH5DeployRef.current?.();
        return;
      }
      if (MANGO_PROJECTS.some((p) => p.key === session.projectKey)) {
        handleMangoDeployRef.current?.(session.projectKey, session.envKey);
        return;
      }
      handleDeployRef.current?.(session.projectKey, session.envKey);
    },
    [sessions, showError]
  );

  // 用 ref 打破循环依赖：这几个 handler 定义在下面但被 rerunSession 引用
  const handleDeployRef = useRef<((projectKey: string, envKey: string) => void) | null>(null);
  const handleH5DeployRef = useRef<(() => void) | null>(null);
  const handleMangoDeployRef = useRef<((projectKey: string, envKey: string) => void) | null>(null);

  /** 真正发起部署：建会话、订阅日志、调后端、落状态与操作日志 */
  const runDeploy = async (req: DeployRequest) => {
    const deployId = `${req.compositeKey}-${++deployCounter}`;

    const session: DeploySession = {
      id: deployId,
      compositeKey: req.compositeKey,
      projectKey: req.projectKey,
      envKey: req.envKey,
      label: req.label,
      logs: [],
      status: "running",
    };

    setSessions((prev) => [...prev, session]);
    setStatusMap((prev) => ({ ...prev, [req.compositeKey]: "running" }));
    setGlobalOpen(false);
    setCollapseAll((n) => n + 1);

    const eventName = `deploy-log-${deployId}`;
    const unlisten = await listen<string>(eventName, (event) => {
      setSessions((prev) =>
        prev.map((s) => s.id === deployId ? { ...s, logs: [...s.logs, event.payload] } : s)
      );
    });

    try {
      await invoke("run_build_and_deploy", {
        params: {
          deploy_id: deployId,
          project_dir: req.projectDir,
          build_command: req.buildCommand || null,
          dist_dir: req.distDir || null,
          targets:
            req.targets?.map((t) => ({
              name: t.name,
              dist_dir: t.distDir,
              key_prefix: t.keyPrefix,
            })) ?? null,
          cos_region: req.cosRegion,
          cos_bucket: req.cosBucket,
          cdn_domain: req.cdnDomain || null,
        },
      });
      if (cancelledIdsRef.current.has(deployId)) {
        cancelledIdsRef.current.delete(deployId);
        return;
      }
      setSessions((prev) =>
        prev.map((s) => s.id === deployId ? { ...s, status: "success" } : s)
      );
      setStatusMap((prev) => ({ ...prev, [req.compositeKey]: "success" }));
      showSuccess(`${req.label} 部署完成！`);
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: `部署 ${req.label}`,
        status: "success",
        detail: "部署完成",
      });
    } catch (err) {
      if (cancelledIdsRef.current.has(deployId)) {
        cancelledIdsRef.current.delete(deployId);
        return;
      }
      setSessions((prev) =>
        prev.map((s) => s.id === deployId ? { ...s, status: "error", logs: [...s.logs, `错误: ${err}`] } : s)
      );
      setStatusMap((prev) => ({ ...prev, [req.compositeKey]: "error" }));
      showError(String(err));
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: `部署 ${req.label}`,
        status: "error",
        detail: `部署失败：${String(err)}`,
      });
    } finally {
      unlisten();
    }
  };

  /** 统一的校验失败处理：弹提示 + 记操作日志 */
  const failValidationFor = (target: string, msg: string) => {
    showError(msg);
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: `部署 ${target}`,
      status: "error",
      detail: `校验未通过：${msg}`,
    });
  };

  const handleDeploy = async (projectKey: string, envKey: string) => {
    const project = config.projects.find((p) => p.key === projectKey);
    const env = project?.envs[envKey];
    if (!project || !env) return;

    const projectDir = project.dir;
    const projectLabel = project.label;
    const envLabel = ENVIRONMENTS.find((e) => e.key === envKey)?.label ?? envKey;
    const deployTarget = `${projectLabel} · ${envLabel}`;

    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「部署」",
      status: "info",
      detail: deployTarget,
    });

    const failValidation = (msg: string) => failValidationFor(deployTarget, msg);

    if (!env.buildCommand && !env.cosRegion && !env.cosBucket) {
      failValidation(`「${projectLabel} - ${envLabel}」的 Build 命令、COS Region、COS Bucket 均未配置，无法执行部署`);
      return;
    }
    if (!projectDir) { failValidation(`请先在全局配置中设置「${projectLabel}」的项目目录`); return; }
    if (!credStatus.configured) { failValidation("请先在全局配置中填写并保存 SecretId / SecretKey"); return; }
    if (!env.buildCommand) { failValidation(`请填写「${projectLabel} - ${envLabel}」的 Build 命令`); return; }
    if (!env.cosRegion) { failValidation(`请填写「${projectLabel} - ${envLabel}」的 COS Region`); return; }
    if (!env.cosBucket) { failValidation(`请填写「${projectLabel} - ${envLabel}」的 COS Bucket`); return; }

    await runDeploy({
      compositeKey: `${projectKey}-${envKey}`,
      projectKey,
      envKey,
      label: deployTarget,
      projectDir,
      buildCommand: env.buildCommand,
      cosRegion: env.cosRegion,
      cosBucket: env.cosBucket,
      cdnDomain: env.cdnDomain,
    });
  };

  const handleH5Deploy = async () => {
    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「H5 发版」",
      status: "info",
      detail: H5_LABEL,
    });

    const failValidation = (msg: string) => failValidationFor(H5_LABEL, msg);

    if (sessions.some((s) => s.compositeKey === H5_COMPOSITE_KEY && s.status === "running")) {
      showError("H5 已有正在运行的发版任务");
      return;
    }
    if (!h5Config.dir) { failValidation("请先设置 H5 项目目录"); return; }
    if (!credStatus.configured) { failValidation("请先在全局配置中填写并保存 SecretId / SecretKey"); return; }
    if (!h5Config.buildCommand) { failValidation("请填写 H5 的打包命令"); return; }
    if (!h5Config.cosRegion) { failValidation("请填写 H5 的 COS Region"); return; }
    if (!h5Config.cosBucket) { failValidation("请填写 H5 的 COS Bucket"); return; }

    await runDeploy({
      compositeKey: H5_COMPOSITE_KEY,
      projectKey: H5_PROJECT_KEY,
      envKey: H5_ENV_KEY,
      label: H5_LABEL,
      projectDir: h5Config.dir,
      buildCommand: h5Config.buildCommand,
      distDir: H5_DIST_DIR,
      cosRegion: h5Config.cosRegion,
      cosBucket: h5Config.cosBucket,
      cdnDomain: h5Config.cdnDomain,
    });
  };

  const handleSelectH5Dir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) setH5Config((prev) => ({ ...prev, dir: selected as string }));
  };

  const updateMangoEnv = (
    projectKey: string,
    envKey: string,
    field: keyof MangoEnvConfig,
    value: string
  ) => {
    setMangoConfigs((prev) => {
      const cfg = prev[projectKey] ?? defaultMangoConfig();
      return {
        ...prev,
        [projectKey]: {
          ...cfg,
          envs: { ...cfg.envs, [envKey]: { ...cfg.envs[envKey], [field]: value } },
        },
      };
    });
  };

  const updateMangoDir = (projectKey: string, dir: string) => {
    setMangoConfigs((prev) => ({
      ...prev,
      [projectKey]: { ...(prev[projectKey] ?? defaultMangoConfig()), dir },
    }));
  };

  const handleSelectMangoDir = async (projectKey: string) => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) updateMangoDir(projectKey, selected as string);
  };

  const handleMangoDeploy = async (projectKey: string, envKey: string) => {
    const project = MANGO_PROJECTS.find((p) => p.key === projectKey);
    const cfg = mangoConfigs[projectKey];
    const env = cfg?.envs[envKey];
    if (!project || !cfg || !env) return;

    const envLabel = MANGO_ENVIRONMENTS.find((e) => e.key === envKey)?.label ?? envKey;
    const deployTarget = `${project.label} · ${envLabel}`;
    const compositeKey = `${projectKey}-${envKey}`;

    logOperation({
      page: LOG_PAGE,
      pageLabel: LOG_PAGE_LABEL,
      action: "点击「部署」",
      status: "info",
      detail: deployTarget,
    });

    const failValidation = (msg: string) => failValidationFor(deployTarget, msg);

    if (sessions.some((s) => s.compositeKey === compositeKey && s.status === "running")) {
      showError(`「${deployTarget}」已有正在运行的部署任务`);
      return;
    }
    if (!cfg.dir) { failValidation(`请先设置「${project.label}」的项目目录`); return; }
    if (!credStatus.configured) { failValidation("请先在全局配置中填写并保存 SecretId / SecretKey"); return; }
    if (!env.buildCommand) { failValidation(`请填写「${deployTarget}」的 Build 命令`); return; }
    if (!env.cosRegion) { failValidation(`请填写「${deployTarget}」的 COS Region`); return; }
    if (!env.cosBucket) { failValidation(`请填写「${deployTarget}」的 COS Bucket`); return; }

    await runDeploy({
      compositeKey,
      projectKey,
      envKey,
      label: deployTarget,
      projectDir: cfg.dir,
      buildCommand: env.buildCommand,
      targets: MANGO_TARGETS,
      cosRegion: env.cosRegion,
      cosBucket: env.cosBucket,
      cdnDomain: env.cdnDomain,
    });
  };

  useEffect(() => {
    handleDeployRef.current = handleDeploy;
    handleH5DeployRef.current = handleH5Deploy;
    handleMangoDeployRef.current = handleMangoDeploy;
  });

  const handleImportConfig = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;

      const content = await invoke<string>("read_text_file", { path: selected });
      const imported = parseConfig(JSON.parse(content));

      if (!imported) {
        showError("JSON 格式不正确，缺少 projects 字段");
        logOperation({
          page: LOG_PAGE,
          pageLabel: LOG_PAGE_LABEL,
          action: "点击「导入配置」",
          status: "error",
          detail: "JSON 格式不正确，缺少 projects 字段",
        });
        return;
      }

      // 已有项目按 key 覆盖，未出现过的 key 作为新项目追加
      const merged: ProjectConfig[] = config.projects.map((existing) => {
        const src = imported.projects.find((p) => p.key === existing.key);
        if (!src) return existing;
        return {
          key: existing.key,
          label: src.label || existing.label,
          dir: src.dir || existing.dir,
          envs: { ...existing.envs, ...src.envs },
        };
      });
      const addedLabels: string[] = [];
      for (const src of imported.projects) {
        if (merged.some((p) => p.key === src.key)) continue;
        merged.push(src);
        addedLabels.push(src.label);
      }

      setConfig({ projects: merged });

      const detail = addedLabels.length
        ? `配置导入成功，新增项目：${addedLabels.join("、")}`
        : "配置导入成功";
      showSuccess(`${detail}！`);
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「导入配置」",
        status: "success",
        detail,
      });
    } catch (err) {
      showError(`导入失败: ${err}`);
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「导入配置」",
        status: "error",
        detail: `导入失败: ${err}`,
      });
    }
  };

  const handleExportTemplate = async () => {
    try {
      const path = await save({
        defaultPath: "deploy-config-template.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;

      await invoke("write_text_file", {
        path,
        content: JSON.stringify(serializeConfig(config), null, 2),
      });

      showSuccess("配置模板已导出（不含密钥）");
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「导出配置模板」",
        status: "success",
        detail: `导出到：${path}`,
      });
    } catch (err) {
      showError(`导出失败: ${err}`);
      logOperation({
        page: LOG_PAGE,
        pageLabel: LOG_PAGE_LABEL,
        action: "点击「导出配置模板」",
        status: "error",
        detail: `导出失败: ${err}`,
      });
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 relative">
      <Alert alert={alert} onClose={closeAlert} />

      <div className="relative z-10 flex flex-col gap-3 mx-auto max-w-[880px]">

        {/* ===== 顶部工具栏 ===== */}
        <div className="flex items-center justify-end">
          <OperationLogButton page={LOG_PAGE} pageLabel={LOG_PAGE_LABEL} />
        </div>

        {/* ===== Global Config (Collapsible) ===== */}
        <GlassCard>
          <button
            onClick={() => setGlobalOpen(!globalOpen)}
            className="w-full flex items-center justify-between px-4 py-3 cursor-pointer select-none"
          >
            <span className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-foreground/80">
              <Settings2 className="size-4 text-muted-foreground" />
              全局配置
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => { e.stopPropagation(); handleImportConfig(); }}
                title="从 JSON 文件导入配置"
              >
                <Import className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => { e.stopPropagation(); handleExportTemplate(); }}
                title="导出配置模板（不含密钥）"
              >
                <FileDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => { e.stopPropagation(); setShowSecrets(!showSecrets); }}
                title={showSecrets ? "隐藏密钥" : "显示密钥"}
              >
                {showSecrets ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </Button>
              <ChevronDown
                className={`size-4 text-muted-foreground transition-transform duration-300 ${globalOpen ? "rotate-180" : ""}`}
              />
            </div>
          </button>

          <div
            className={`overflow-hidden transition-all duration-300 ease-out ${
              globalOpen ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
            }`}
          >
            <div className="px-4 pb-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">项目列表</Label>
                <Button variant="outline" size="xs" onClick={addProject}>
                  <Plus className="size-3 mr-1" />
                  添加项目
                </Button>
              </div>
              {config.projects.map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <Input
                    value={p.label}
                    onChange={(e) => updateProject(p.key, "label", e.target.value)}
                    placeholder="项目名称"
                    title={`配置模板中的标识：${p.key}`}
                    className="text-xs h-7 w-[110px] shrink-0 bg-white/60 dark:bg-white/[0.04]"
                  />
                  <Input
                    value={p.dir}
                    onChange={(e) => updateProject(p.key, "dir", e.target.value)}
                    placeholder={`${p.label || "项目"}本地路径`}
                    className="text-xs h-7 flex-1 bg-white/60 dark:bg-white/[0.04]"
                  />
                  <Button variant="outline" size="xs" onClick={() => handleSelectDir(p.key)} className="shrink-0">
                    <FolderOpen className="size-3 mr-1" />
                    浏览
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => removeProject(p.key)}
                    title="删除该项目"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
              <div className={`${glassInner} mt-1 p-2.5 flex flex-col gap-2.5`}>
                <div className="flex items-center gap-2">
                  <KeyRound className="size-3.5 text-muted-foreground shrink-0" />
                  {credStatus.configured ? (
                    <>
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">
                        密钥已存入系统凭证管理器
                      </span>
                      <span className="text-xs font-mono text-muted-foreground truncate">
                        {credStatus.secret_id_hint}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={handleDeleteSecrets}
                        title="删除已保存的密钥"
                        className="ml-auto shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-amber-600 dark:text-amber-500">
                      尚未配置密钥，填写后点击保存
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground w-[90px] shrink-0">SecretId</Label>
                  <Input
                    value={secretIdInput}
                    onChange={(e) => setSecretIdInput(e.target.value)}
                    type={showSecrets ? "text" : "password"}
                    autoComplete="off"
                    placeholder={credStatus.configured ? "如需更换请填入新的 SecretId" : "腾讯云 SecretId"}
                    className="text-xs h-7 flex-1 bg-white/60 dark:bg-white/[0.04]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground w-[90px] shrink-0">SecretKey</Label>
                  <Input
                    value={secretKeyInput}
                    onChange={(e) => setSecretKeyInput(e.target.value)}
                    type={showSecrets ? "text" : "password"}
                    autoComplete="off"
                    placeholder={credStatus.configured ? "如需更换请填入新的 SecretKey" : "腾讯云 SecretKey"}
                    className="text-xs h-7 flex-1 bg-white/60 dark:bg-white/[0.04]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground leading-tight">
                    密钥只保存在系统凭证管理器，不写入本地配置文件，部署时由后端直接取用
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={handleSaveSecrets}
                    disabled={savingSecrets || !secretIdInput.trim() || !secretKeyInput.trim()}
                    className="ml-auto shrink-0"
                  >
                    {savingSecrets ? (
                      <Loader2 className="size-3 mr-1 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-3 mr-1" />
                    )}
                    保存密钥
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </GlassCard>

        {/* ===== Project Groups ===== */}
        {config.projects.length === 0 && (
          <GlassCard className="px-4 py-6 text-center text-xs text-muted-foreground">
            暂无项目，请在「全局配置」中添加项目或导入配置模板
          </GlassCard>
        )}
        {config.projects.map((project) => (
          <ProjectGroup
            key={project.key}
            project={project}
            envConfigs={project.envs}
            statusMap={statusMap}
            runningKeys={runningKeys}
            collapseSignal={collapseAll}
            onUpdateEnv={(envKey, field, value) => updateEnv(project.key, envKey, field, value)}
            onDeploy={(envKey) => handleDeploy(project.key, envKey)}
          />
        ))}

        {/* ===== 总后台（微前端三产物，内置配置，不走模板） ===== */}
        {MANGO_PROJECTS.map((p) => (
          <MangoCard
            key={p.key}
            label={p.label}
            projectKey={p.key}
            config={mangoConfigs[p.key] ?? defaultMangoConfig()}
            statusMap={statusMap}
            runningKeys={runningKeys}
            collapseSignal={collapseAll}
            onUpdateDir={(value) => updateMangoDir(p.key, value)}
            onUpdateEnv={(envKey, field, value) => updateMangoEnv(p.key, envKey, field, value)}
            onSelectDir={() => handleSelectMangoDir(p.key)}
            onReset={() => setMangoConfigs((prev) => ({ ...prev, [p.key]: defaultMangoConfig() }))}
            onDeploy={(envKey) => handleMangoDeploy(p.key, envKey)}
          />
        ))}

        {/* ===== H5（内置配置，不走模板） ===== */}
        <H5Card
          config={h5Config}
          status={statusMap[H5_COMPOSITE_KEY] ?? "idle"}
          isRunning={runningKeys.includes(H5_COMPOSITE_KEY)}
          onUpdate={(field, value) => setH5Config((prev) => ({ ...prev, [field]: value }))}
          onSelectDir={handleSelectH5Dir}
          onReset={() => setH5Config({ ...H5_DEFAULT_CONFIG })}
          onDeploy={handleH5Deploy}
        />

        {/* ===== Log Panels ===== */}
        {sessions.length > 0 && (
          <GlassCard className="overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-[13px] font-semibold tracking-wide text-foreground/80">
                部署日志
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  setSessions([]);
                  logOperation({
                    page: LOG_PAGE,
                    pageLabel: LOG_PAGE_LABEL,
                    action: "点击「清空全部日志」",
                    status: "info",
                    detail: "清空部署日志面板",
                  });
                }}
                title="清空全部日志"
              >
                <Eraser className="size-3.5" />
              </Button>
            </div>
            <div className="px-3 pb-3">
              <div className="flex gap-2 transition-all duration-500 ease-out">
                {sessions.map((session) => (
                  <LogPanel
                    key={session.id}
                    session={session}
                    count={sessions.length}
                    onRemove={() => removeSession(session.id)}
                    onRerun={() => rerunSession(session)}
                  />
                ))}
              </div>
            </div>
          </GlassCard>
        )}
      </div>
    </div>
  );
}

// ==================== Log Panel ====================

function LogPanel({
  session,
  count,
  onRemove,
  onRerun,
}: {
  session: DeploySession;
  count: number;
  onRemove: () => void;
  onRerun: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.logs]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateX(0)"; });
  }, []);

  const statusColor =
    session.status === "success" ? "text-emerald-400" :
    session.status === "error" ? "text-red-400" :
    "text-sky-300";

  const statusDot =
    session.status === "success" ? "bg-emerald-500" :
    session.status === "error" ? "bg-red-500" :
    "bg-amber-500 animate-pulse";

  const isRunning = session.status === "running";

  return (
    <div
      ref={panelRef}
      className="flex flex-col min-w-0 transition-all duration-500 ease-out"
      style={{
        flex: `1 1 ${100 / count}%`,
        opacity: 0,
        transform: "translateX(40px)",
      }}
    >
      <div className="flex items-center justify-between mb-1.5 px-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/70 truncate">
          <span className={`size-1.5 rounded-full shrink-0 ${statusDot}`} />
          <span className="truncate">{session.label}</span>
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {!isRunning && (
            <button
              onClick={onRerun}
              className="p-0.5 rounded hover:bg-white/10 transition-colors"
              title="重新执行"
            >
              <RotateCw className="size-3 text-muted-foreground" />
            </button>
          )}
          <button
            onClick={onRemove}
            className="p-0.5 rounded hover:bg-white/10 transition-colors"
            title={isRunning ? "取消并关闭" : "关闭"}
          >
            <X className="size-3 text-muted-foreground" />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="bg-[#1a1a2e]/90 dark:bg-black/60 rounded-xl p-3 max-h-[200px] overflow-y-auto font-mono text-[11px] leading-[1.7] flex-1"
      >
        {session.logs.map((line, i) => (
          <div
            key={i}
            className={
              line.includes("✓") || line.includes("完成")
                ? "text-emerald-400"
                : line.includes("错误") || line.includes("失败")
                ? "text-red-400"
                : line.startsWith("[")
                ? "text-sky-300"
                : "text-gray-400"
            }
          >
            {line}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {session.status !== "running" && (
        <div className={`text-[10px] mt-1 px-1 ${statusColor}`}>
          {session.status === "success" ? "部署完成" : "部署失败"}
        </div>
      )}
    </div>
  );
}

// ==================== Project Group ====================

function ProjectGroup({
  project,
  envConfigs,
  statusMap,
  runningKeys,
  collapseSignal,
  onUpdateEnv,
  onDeploy,
}: {
  project: ProjectConfig;
  envConfigs: Record<string, EnvConfig>;
  statusMap: Record<string, DeployStatus>;
  runningKeys: string[];
  collapseSignal: number;
  onUpdateEnv: (envKey: string, field: keyof EnvConfig, value: string) => void;
  onDeploy: (envKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (collapseSignal > 0) setExpanded(false);
  }, [collapseSignal]);

  return (
    <GlassCard>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer select-none"
      >
        <span className="text-[13px] font-semibold tracking-wide text-foreground/80">
          {project.label}
        </span>
        <div className="flex items-center gap-2">
          {ENVIRONMENTS.map((env) => {
            const key = `${project.key}-${env.key}`;
            const st = statusMap[key];
            return (
              <span key={env.key} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className={`size-1.5 rounded-full ${
                  st === "success" ? "bg-emerald-500" :
                  st === "error" ? "bg-red-500" :
                  st === "running" ? "bg-amber-500 animate-pulse" :
                  env.dot
                }`} />
                {env.label.replace("环境", "")}
              </span>
            );
          })}
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform duration-300 ml-1 ${expanded ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          expanded ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="px-3 pb-3 grid grid-cols-3 gap-2">
          {ENVIRONMENTS.map((env) => {
            const compositeKey = `${project.key}-${env.key}`;
            const isThisRunning = runningKeys.includes(compositeKey);
            return (
              <EnvCard
                key={env.key}
                env={env}
                config={envConfigs[env.key] ?? defaultEnvConfig()}
                status={statusMap[compositeKey] ?? "idle"}
                isThisRunning={isThisRunning}
                isDisabled={isThisRunning}
                onUpdate={(field, value) => onUpdateEnv(env.key, field, value)}
                onDeploy={() => onDeploy(env.key)}
              />
            );
          })}
        </div>
      </div>
    </GlassCard>
  );
}

// ==================== Env Card ====================

function EnvCard({
  env,
  config,
  status,
  isThisRunning,
  isDisabled,
  onUpdate,
  onDeploy,
}: {
  env: (typeof ENVIRONMENTS)[number];
  config: EnvConfig;
  status: DeployStatus;
  isThisRunning: boolean;
  isDisabled: boolean;
  onUpdate: (field: keyof EnvConfig, value: string) => void;
  onDeploy: () => void;
}) {
  const statusIcon = () => {
    if (isThisRunning) return <Loader2 className="size-3 animate-spin" />;
    if (status === "success") return <CheckCircle2 className="size-3 text-emerald-500" />;
    if (status === "error") return <XCircle className="size-3 text-red-500" />;
    return <Rocket className="size-3" />;
  };

  return (
    <div className={`${glassInner} p-3 flex flex-col gap-2`}>
      <div className={`flex items-center gap-1.5 mb-0.5`}>
        <span className={`size-2 rounded-full ${env.dot}`} />
        <span className="text-[12px] font-medium text-foreground/80">{env.label}</span>
      </div>

      <MiniField label="Build" value={config.buildCommand} onChange={(v) => onUpdate("buildCommand", v)} placeholder="npm run build" />
      <MiniField label="Region" value={config.cosRegion} onChange={(v) => onUpdate("cosRegion", v)} placeholder="ap-beijing" />
      <MiniField label="Bucket" value={config.cosBucket} onChange={(v) => onUpdate("cosBucket", v)} placeholder="bucket-125xxx" />
      <MiniField label="域名" value={config.cdnDomain} onChange={(v) => onUpdate("cdnDomain", v)} placeholder="xxx.example.com" />

      <Button
        size="sm"
        onClick={onDeploy}
        disabled={isDisabled}
        className={`w-full mt-1 gap-1 text-[11px] h-7 rounded-lg transition-all ${
          isThisRunning
            ? "bg-amber-500/80 text-white"
            : status === "success"
            ? "bg-emerald-500/80 text-white hover:bg-emerald-500/90"
            : status === "error"
            ? "bg-red-500/80 text-white hover:bg-red-500/90"
            : ""
        }`}
      >
        {statusIcon()}
        {isThisRunning ? "部署中..." : status === "success" ? "已完成" : status === "error" ? "重试" : "部署"}
      </Button>
    </div>
  );
}