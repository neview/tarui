# 打包指南

本文档介绍如何将 tauri-app 打包为 Windows 和 macOS 桌面应用。

---

## 环境要求

| 工具 | 说明 |
|------|------|
| Node.js | LTS 版本 |
| pnpm | 包管理器 |
| Rust | stable 版本，通过 [rustup](https://rustup.rs/) 安装 |

---

## 一、本地打包（Windows）

> 本地只能打包当前操作系统的安装包。Windows 电脑只能打包 Windows 版本，Mac 电脑只能打包 macOS 版本。

### 1. 安装依赖

```bash
pnpm install
```

### 2. 打包

```bash
pnpm tauri build
```

该命令会自动执行：
1. TypeScript 编译 + Vite 构建前端（`tsc && vite build`）
2. 编译 Rust 后端
3. 生成安装包

### 3. 产物位置

构建完成后，安装包位于 `src-tauri/target/release/bundle/`：

| 目录 | 文件格式 | 说明 |
|------|----------|------|
| `nsis/` | `.exe` | NSIS 安装程序，推荐分发给用户 |
| `msi/` | `.msi` | Windows Installer 安装包 |

### 4. 可选参数

```bash
# 只生成 .exe 安装程序
pnpm tauri build --bundles nsis

# 只生成 .msi 安装包
pnpm tauri build --bundles msi

# 打包调试版本（可右键打开开发者工具）
pnpm tauri build --debug
```

调试版本产物位于 `src-tauri/target/debug/bundle/`。

---

## 二、GitHub Actions 自动打包（Windows + macOS）

项目已配置 GitHub Actions 工作流（`.github/workflows/release.yml`），可自动构建 3 个平台的安装包：

| 平台 | 安装包格式 |
|------|-----------|
| Windows | `.exe` + `.msi` |
| macOS Apple Silicon（M1/M2/M3/M4） | `.dmg` |
| macOS Intel | `.dmg` |

### 触发方式

#### 方式一：打 Tag 自动触发

```bash
# 1. 确保所有代码已提交并推送
git add .
git commit -m "release: v1.2.0"
git push origin main

# 2. 创建版本 Tag 并推送
git tag v1.2.0
git push origin v1.2.0
```

> **注意：** Tag 的版本号必须与 `src-tauri/tauri.conf.json` 和 `package.json` 中的 `version` 字段一致。

#### 方式二：手动触发

1. 打开 GitHub 仓库页面
2. 点击 **Actions** 选项卡
3. 左侧选择 **Build & Release**
4. 点击 **Run workflow** → **Run workflow**

### 查看构建结果

1. 进入 **Actions** 选项卡查看构建进度（通常需要 5-15 分钟）
2. 构建成功后，进入 **Releases** 页面
3. 会看到一个 **Draft**（草稿）状态的 Release，包含所有平台的安装包
4. 检查无误后点击 **Publish release** 发布

---

## 三、版本号更新

发布新版本前，需要同时更新两个文件中的版本号：

| 文件 | 字段 |
|------|------|
| `package.json` | `"version"` |
| `src-tauri/tauri.conf.json` | `"version"` |

两个文件的版本号必须保持一致，且与 Git Tag（去掉 `v` 前缀）一致。

例如发布 `v1.2.0`：
- `package.json` → `"version": "1.2.0"`
- `tauri.conf.json` → `"version": "1.2.0"`
- Git Tag → `v1.2.0`

---

## 四、应用图标

图标文件位于 `src-tauri/icons/`，如需更换应用图标：

1. 准备一张至少 1024x1024 像素的 PNG 图片
2. 运行以下命令自动生成所有尺寸：

```bash
pnpm tauri icon path/to/your-icon.png
```

3. 提交生成的图标文件到 Git

---

## 常见问题

### Q: TypeScript 编译失败怎么办？

打包前先运行检查：

```bash
npx tsc --noEmit
```

修复所有报错后再执行打包。

### Q: 为什么 GitHub Actions 没有触发？

确保推送顺序正确：**先推送代码，再推送 Tag**。如果 Tag 对应的 commit 中不包含 workflow 文件，Actions 不会触发。

### Q: 为什么 Releases 页面没有安装包？

检查 Actions 选项卡中的构建是否成功。如果失败，点击进入查看具体错误日志。
