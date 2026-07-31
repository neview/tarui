import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  FolderOpen,
  Rocket,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  RotateCcw,
} from "lucide-react";
import { GlassCard, MiniField, glassInner, miniInputClass, type DeployStatus } from "./ui";

/**
 * 总后台是微前端结构，一次发版要打三份产物并分别落到桶里不同前缀下，
 * 和其他单产物项目差别太大，所以和 H5 一样做成内置卡片：
 * 配置写在下面的常量里，存独立的 localStorage 键，不参与配置模板的导入导出。
 *
 * 产物映射对齐项目自带的 deploy-cos.js / deploy-cos-test.js / deploy-cos-preview.js，
 * 三个环境用的都是同一份映射。改这里之前先确认那三个脚本也一起改了。
 */
export const MANGO_TARGETS: MangoTarget[] = [
  { name: "base-app", distDir: "base-app/dist", keyPrefix: "" },
  { name: "legacy", distDir: "dist", keyPrefix: "legacy/" },
  { name: "new-app", distDir: "new-app/dist", keyPrefix: "new/" },
];

export interface MangoTarget {
  /** 日志里显示的名字 */
  name: string;
  /** 产物目录，相对项目根目录 */
  distDir: string;
  /** COS key 前缀，空串表示挂到桶根 */
  keyPrefix: string;
}

export const MANGO_ENVIRONMENTS = [
  { key: "prod", label: "正式环境", dot: "bg-emerald-500" },
  { key: "test", label: "测试环境", dot: "bg-amber-500" },
  { key: "backup", label: "备用正式环境", dot: "bg-violet-500" },
] as const;

export interface MangoEnvConfig {
  buildCommand: string;
  cosRegion: string;
  cosBucket: string;
  cdnDomain: string;
}

export interface MangoConfig {
  /** 项目本地根目录 */
  dir: string;
  envs: Record<string, MangoEnvConfig>;
}

/**
 * 默认的桶 / 地域 / 域名取自项目里的三个发布脚本。
 * 备用正式环境对应 deploy-cos:preview，那个脚本只上传不刷新 CDN，
 * 所以域名留空 —— 后端读到空域名会自动跳过刷新和预热，行为一致。
 */
const DEFAULT_ENVS: Record<string, MangoEnvConfig> = {
  prod: {
    buildCommand: "npm run build:all",
    cosRegion: "ap-nanjing",
    cosBucket: "mango-20201115-1303204763",
    cdnDomain: "https://admin.mgmovie.net/",
  },
  test: {
    buildCommand: "npm run build:all:test",
    cosRegion: "ap-nanjing",
    cosBucket: "test-admin-1303204763",
    cdnDomain: "http://test-admin.mgmovie.net/",
  },
  backup: {
    buildCommand: "npm run build:all",
    cosRegion: "ap-shanghai",
    cosBucket: "mango-admin-dev-1303204763",
    cdnDomain: "",
  },
};

/** 两份代码按需切换上线，走的是同一套线上环境，所以默认桶和域名相同，只有目录不同 */
export const MANGO_PROJECTS = [
  { key: "__mango_master__", label: "总后台-master", storageKey: "mango-deploy-master-v1" },
  { key: "__mango_mgjt__", label: "总后台-MGJT", storageKey: "mango-deploy-mgjt-v1" },
] as const;

export type MangoProjectKey = (typeof MANGO_PROJECTS)[number]["key"];

export function defaultMangoConfig(): MangoConfig {
  return {
    dir: "",
    envs: Object.fromEntries(
      Object.entries(DEFAULT_ENVS).map(([k, v]) => [k, { ...v }])
    ),
  };
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function loadMangoConfig(storageKey: string): MangoConfig {
  const base = defaultMangoConfig();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return base;

    const envs: Record<string, MangoEnvConfig> = {};
    for (const env of MANGO_ENVIRONMENTS) {
      const src = parsed.envs?.[env.key];
      const fallback = base.envs[env.key];
      envs[env.key] = src && typeof src === "object"
        ? {
            buildCommand: readString(src.buildCommand, fallback.buildCommand),
            cosRegion: readString(src.cosRegion, fallback.cosRegion),
            cosBucket: readString(src.cosBucket, fallback.cosBucket),
            // 域名允许被显式清空，不能用默认值兜底
            cdnDomain: readString(src.cdnDomain, fallback.cdnDomain),
          }
        : fallback;
    }
    return { dir: readString(parsed.dir, base.dir), envs };
  } catch {
    return base;
  }
}

export function saveMangoConfig(storageKey: string, config: MangoConfig) {
  localStorage.setItem(storageKey, JSON.stringify(config));
}

// ==================== Mango Card ====================

export function MangoCard({
  label,
  config,
  statusMap,
  runningKeys,
  projectKey,
  collapseSignal,
  onUpdateDir,
  onUpdateEnv,
  onSelectDir,
  onReset,
  onDeploy,
}: {
  label: string;
  config: MangoConfig;
  statusMap: Record<string, DeployStatus>;
  runningKeys: string[];
  projectKey: string;
  collapseSignal: number;
  onUpdateDir: (value: string) => void;
  onUpdateEnv: (envKey: string, field: keyof MangoEnvConfig, value: string) => void;
  onSelectDir: () => void;
  onReset: () => void;
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
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold tracking-wide text-foreground/80 shrink-0">
            {label}
          </span>
          <span className="text-[10px] text-muted-foreground truncate">
            微前端三产物，内置配置不参与模板导入导出
          </span>
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {MANGO_ENVIRONMENTS.map((env) => {
            const st = statusMap[`${projectKey}-${env.key}`];
            return (
              <span key={env.key} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span
                  className={`size-1.5 rounded-full ${
                    st === "success"
                      ? "bg-emerald-500"
                      : st === "error"
                      ? "bg-red-500"
                      : st === "running"
                      ? "bg-amber-500 animate-pulse"
                      : env.dot
                  }`}
                />
                {env.label.replace("环境", "")}
              </span>
            );
          })}
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform duration-300 ml-1 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          expanded ? "max-h-[900px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="px-3 pb-3 flex flex-col gap-2">
          <div className={`${glassInner} p-3 flex flex-col gap-2`}>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground w-[38px] shrink-0 text-right">
                目录
              </span>
              <input
                value={config.dir}
                onChange={(e) => onUpdateDir(e.target.value)}
                placeholder="总后台项目本地路径"
                className={miniInputClass}
              />
              <Button variant="outline" size="xs" onClick={onSelectDir} className="shrink-0">
                <FolderOpen className="size-3 mr-1" />
                浏览
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={onReset}
                title="恢复内置默认配置"
                className="shrink-0"
              >
                <RotateCcw className="size-3 mr-1" />
                恢复默认
              </Button>
            </div>

            <div className="flex items-start gap-1.5">
              <span className="text-[10px] text-muted-foreground w-[38px] shrink-0 text-right pt-1">
                产物
              </span>
              <div className="flex-1 flex flex-wrap gap-1.5">
                {MANGO_TARGETS.map((t) => (
                  <span
                    key={t.name}
                    title="产物映射已固定，不可修改"
                    className="h-6 px-2 flex items-center gap-1 text-[10px] font-mono rounded-md border border-dashed border-white/30 dark:border-white/[0.08] text-muted-foreground"
                  >
                    {t.distDir}
                    <span className="opacity-50">→</span>
                    {t.keyPrefix || "<桶根>"}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {MANGO_ENVIRONMENTS.map((env) => {
              const compositeKey = `${projectKey}-${env.key}`;
              const isThisRunning = runningKeys.includes(compositeKey);
              return (
                <MangoEnvCard
                  key={env.key}
                  env={env}
                  config={config.envs[env.key] ?? DEFAULT_ENVS[env.key]}
                  status={statusMap[compositeKey] ?? "idle"}
                  isThisRunning={isThisRunning}
                  onUpdate={(field, value) => onUpdateEnv(env.key, field, value)}
                  onDeploy={() => onDeploy(env.key)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </GlassCard>
  );
}

function MangoEnvCard({
  env,
  config,
  status,
  isThisRunning,
  onUpdate,
  onDeploy,
}: {
  env: (typeof MANGO_ENVIRONMENTS)[number];
  config: MangoEnvConfig;
  status: DeployStatus;
  isThisRunning: boolean;
  onUpdate: (field: keyof MangoEnvConfig, value: string) => void;
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
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className={`size-2 rounded-full ${env.dot}`} />
        <span className="text-[12px] font-medium text-foreground/80">{env.label}</span>
      </div>

      <MiniField
        label="Build"
        value={config.buildCommand}
        onChange={(v) => onUpdate("buildCommand", v)}
        placeholder="npm run build:all"
      />
      <MiniField
        label="Region"
        value={config.cosRegion}
        onChange={(v) => onUpdate("cosRegion", v)}
        placeholder="ap-nanjing"
      />
      <MiniField
        label="Bucket"
        value={config.cosBucket}
        onChange={(v) => onUpdate("cosBucket", v)}
        placeholder="bucket-125xxx"
      />
      <MiniField
        label="域名"
        value={config.cdnDomain}
        onChange={(v) => onUpdate("cdnDomain", v)}
        placeholder="留空则跳过 CDN 刷新"
      />

      <Button
        size="sm"
        onClick={onDeploy}
        disabled={isThisRunning}
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
