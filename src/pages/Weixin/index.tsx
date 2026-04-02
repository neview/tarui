import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Alert, useAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  X,
} from "lucide-react";

// ==================== Data Model ====================

interface EnvConfig {
  buildCommand: string;
  cosRegion: string;
  cosBucket: string;
  cdnDomain: string;
}

interface GlobalConfig {
  mangoDir: string;
  agentDir: string;
  orderDir: string;
  secretId: string;
  secretKey: string;
}

interface AllConfig {
  global: GlobalConfig;
  projects: Record<string, Record<string, EnvConfig>>;
}

const PROJECT_GROUPS = [
  { key: "mango", label: "芒果总后台" },
  { key: "agent", label: "代理后台" },
  { key: "order", label: "网页接单后台" },
] as const;

const ENVIRONMENTS = [
  { key: "prod", label: "正式环境", color: "from-emerald-500/20 to-teal-500/20", dot: "bg-emerald-500" },
  { key: "test", label: "测试环境", color: "from-amber-500/20 to-orange-500/20", dot: "bg-amber-500" },
  { key: "backup", label: "备用正式环境", color: "from-violet-500/20 to-purple-500/20", dot: "bg-violet-500" },
] as const;

const STORAGE_KEY = "weixin-deploy-config-v2";

function defaultEnvConfig(): EnvConfig {
  return { buildCommand: "npm run build", cosRegion: "", cosBucket: "", cdnDomain: "" };
}

function defaultGlobal(): GlobalConfig {
  return { mangoDir: "", agentDir: "", orderDir: "", secretId: "", secretKey: "" };
}

function loadAllConfig(): AllConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const g = parsed.global ?? {};
      return {
        global: { ...defaultGlobal(), ...g },
        projects: parsed.projects ?? {},
      };
    }
  } catch {}
  const projects: Record<string, Record<string, EnvConfig>> = {};
  for (const p of PROJECT_GROUPS) {
    projects[p.key] = {};
    for (const e of ENVIRONMENTS) {
      projects[p.key][e.key] = defaultEnvConfig();
    }
  }
  return { global: defaultGlobal(), projects };
}

function saveAllConfig(config: AllConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

type DeployStatus = "idle" | "running" | "success" | "error";

// ==================== Glass Card Primitives ====================

const glass =
  "backdrop-blur-xl bg-white/60 dark:bg-white/[0.06] border border-white/40 dark:border-white/[0.08] shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)]";
const glassInner =
  "bg-white/50 dark:bg-white/[0.04] border border-white/50 dark:border-white/[0.06] rounded-xl";

function GlassCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl ${glass} ${className}`}>
      {children}
    </div>
  );
}

// ==================== Deploy Session ====================

interface DeploySession {
  id: string;
  compositeKey: string;
  label: string;
  logs: string[];
  status: "running" | "success" | "error";
}

let deployCounter = 0;

// ==================== Main Component ====================

export default function Weixin() {
  const { alert, showSuccess, showError, closeAlert } = useAlert();
  const [config, setConfig] = useState<AllConfig>(loadAllConfig);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [sessions, setSessions] = useState<DeploySession[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, DeployStatus>>({});
  const [collapseAll, setCollapseAll] = useState(0);

  useEffect(() => { saveAllConfig(config); }, [config]);

  const runningKeys = sessions.filter((s) => s.status === "running").map((s) => s.compositeKey);

  const updateGlobal = (field: keyof GlobalConfig, value: string) => {
    setConfig((prev) => ({ ...prev, global: { ...prev.global, [field]: value } }));
  };

  const updateEnv = (projectKey: string, envKey: string, field: keyof EnvConfig, value: string) => {
    setConfig((prev) => ({
      ...prev,
      projects: {
        ...prev.projects,
        [projectKey]: {
          ...prev.projects[projectKey],
          [envKey]: { ...prev.projects[projectKey][envKey], [field]: value },
        },
      },
    }));
  };

  const handleSelectDir = async (field: keyof GlobalConfig) => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) updateGlobal(field, selected as string);
  };

  const projectDirMap: Record<string, keyof GlobalConfig> = {
    mango: "mangoDir",
    agent: "agentDir",
    order: "orderDir",
  };

  const removeSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleDeploy = async (projectKey: string, envKey: string) => {
    const g = config.global;
    const env = config.projects[projectKey]?.[envKey];
    if (!env) return;

    const dirField = projectDirMap[projectKey];
    const projectDir = g[dirField] as string;
    const projectLabel = PROJECT_GROUPS.find((p) => p.key === projectKey)?.label ?? projectKey;
    const envLabel = ENVIRONMENTS.find((e) => e.key === envKey)?.label ?? envKey;

    if (!env.buildCommand && !env.cosRegion && !env.cosBucket) {
      showError(`「${projectLabel} - ${envLabel}」的 Build 命令、COS Region、COS Bucket 均未配置，无法执行部署`);
      return;
    }
    if (!projectDir) { showError(`请先在全局配置中设置「${projectLabel}」的项目目录`); return; }
    if (!g.secretId || !g.secretKey) { showError("请先在全局配置中填写 SecretId / SecretKey"); return; }
    if (!env.buildCommand) { showError(`请填写「${projectLabel} - ${envLabel}」的 Build 命令`); return; }
    if (!env.cosRegion) { showError(`请填写「${projectLabel} - ${envLabel}」的 COS Region`); return; }
    if (!env.cosBucket) { showError(`请填写「${projectLabel} - ${envLabel}」的 COS Bucket`); return; }

    const compositeKey = `${projectKey}-${envKey}`;
    const deployId = `${compositeKey}-${++deployCounter}`;

    const session: DeploySession = {
      id: deployId,
      compositeKey,
      label: `${projectLabel} · ${envLabel}`,
      logs: [],
      status: "running",
    };

    setSessions((prev) => [...prev, session]);
    setStatusMap((prev) => ({ ...prev, [compositeKey]: "running" }));
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
          project_dir: projectDir,
          build_command: env.buildCommand || null,
          cos_secret_id: g.secretId,
          cos_secret_key: g.secretKey,
          cos_region: env.cosRegion,
          cos_bucket: env.cosBucket,
          cdn_secret_id: g.secretId,
          cdn_secret_key: g.secretKey,
          cdn_domain: env.cdnDomain || null,
        },
      });
      setSessions((prev) =>
        prev.map((s) => s.id === deployId ? { ...s, status: "success" } : s)
      );
      setStatusMap((prev) => ({ ...prev, [compositeKey]: "success" }));
      showSuccess(`${projectLabel} · ${envLabel} 部署完成！`);
    } catch (err) {
      setSessions((prev) =>
        prev.map((s) => s.id === deployId ? { ...s, status: "error", logs: [...s.logs, `错误: ${err}`] } : s)
      );
      setStatusMap((prev) => ({ ...prev, [compositeKey]: "error" }));
      showError(String(err));
    } finally {
      unlisten();
    }
  };

  const handleImportConfig = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;

      const content = await invoke<string>("read_text_file", { path: selected });
      const imported = JSON.parse(content) as AllConfig;

      if (!imported.global || !imported.projects) {
        showError("JSON 格式不正确，缺少 global 或 projects 字段");
        return;
      }

      const ig = imported.global ?? {};
      const merged: AllConfig = {
        global: {
          mangoDir: ig.mangoDir || config.global.mangoDir || "",
          agentDir: ig.agentDir || config.global.agentDir || "",
          orderDir: ig.orderDir || config.global.orderDir || "",
          secretId: ig.secretId || config.global.secretId || "",
          secretKey: ig.secretKey || config.global.secretKey || "",
        },
        projects: { ...config.projects },
      };

      for (const p of PROJECT_GROUPS) {
        if (!imported.projects?.[p.key]) continue;
        for (const e of ENVIRONMENTS) {
          const src = imported.projects[p.key]?.[e.key];
          if (!src) continue;
          merged.projects[p.key] = merged.projects[p.key] ?? {};
          merged.projects[p.key][e.key] = {
            buildCommand: src.buildCommand || defaultEnvConfig().buildCommand,
            cosRegion: src.cosRegion || "",
            cosBucket: src.cosBucket || "",
            cdnDomain: src.cdnDomain || "",
          };
        }
      }

      setConfig(merged);
      showSuccess("配置导入成功！");
    } catch (err) {
      showError(`导入失败: ${err}`);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 relative">
      <Alert alert={alert} onClose={closeAlert} />

      <div className="relative z-10 flex flex-col gap-3 mx-auto max-w-[880px]">

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
              globalOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
            }`}
          >
            <div className="px-4 pb-4 flex flex-col gap-2.5">
              {PROJECT_GROUPS.map((p) => {
                const field = projectDirMap[p.key];
                return (
                  <div key={p.key} className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground w-[90px] shrink-0">{p.label}</Label>
                    <Input
                      value={config.global[field] as string}
                      onChange={(e) => updateGlobal(field, e.target.value)}
                      placeholder={`${p.label}项目路径`}
                      className="text-xs h-7 flex-1 bg-white/60 dark:bg-white/[0.04]"
                    />
                    <Button variant="outline" size="xs" onClick={() => handleSelectDir(field)} className="shrink-0">
                      <FolderOpen className="size-3 mr-1" />
                      浏览
                    </Button>
                  </div>
                );
              })}
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground w-[90px] shrink-0">SecretId</Label>
                <Input
                  value={config.global.secretId}
                  onChange={(e) => updateGlobal("secretId", e.target.value)}
                  type={showSecrets ? "text" : "password"}
                  placeholder="腾讯云 SecretId"
                  className="text-xs h-7 flex-1 bg-white/60 dark:bg-white/[0.04]"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground w-[90px] shrink-0">SecretKey</Label>
                <Input
                  value={config.global.secretKey}
                  onChange={(e) => updateGlobal("secretKey", e.target.value)}
                  type={showSecrets ? "text" : "password"}
                  placeholder="腾讯云 SecretKey"
                  className="text-xs h-7 flex-1 bg-white/60 dark:bg-white/[0.04]"
                />
              </div>
            </div>
          </div>
        </GlassCard>

        {/* ===== Project Groups ===== */}
        {PROJECT_GROUPS.map((project) => (
          <ProjectGroup
            key={project.key}
            project={project}
            envConfigs={config.projects[project.key] ?? {}}
            statusMap={statusMap}
            runningKeys={runningKeys}
            collapseSignal={collapseAll}
            onUpdateEnv={(envKey, field, value) => updateEnv(project.key, envKey, field, value)}
            onDeploy={(envKey) => handleDeploy(project.key, envKey)}
          />
        ))}

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
                onClick={() => setSessions([])}
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
}: {
  session: DeploySession;
  count: number;
  onRemove: () => void;
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
        {session.status !== "running" && (
          <button
            onClick={onRemove}
            className="shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
            title="关闭"
          >
            <X className="size-3 text-muted-foreground" />
          </button>
        )}
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
  project: (typeof PROJECT_GROUPS)[number];
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

// ==================== Mini Field ====================

function MiniField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-[38px] shrink-0 text-right">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 h-6 px-1.5 text-[11px] rounded-md border border-white/30 dark:border-white/[0.08] bg-white/40 dark:bg-white/[0.03] outline-none placeholder:text-muted-foreground/50 focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all"
      />
    </div>
  );
}
