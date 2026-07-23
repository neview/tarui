// 同步「唯一真源」的 Python 脚本到桌面端项目根目录。
//
// 背景：发布逻辑（release_version.py 等）在后端仓库 py-test 里维护，
// 桌面端「本地脚本模式」需要一份同样的脚本随应用一起打包。
// 为避免手动复制导致两份不一致，这里以 py-test 为唯一真源，在
// dev/build 前自动同步过来（见 package.json 的 dev / build 脚本）。
//
// 设计原则：
// - 找不到源文件（例如 CI 上没有 checkout py-test）时「跳过并告警」，
//   不让构建失败——此时会使用仓库里已提交的副本。
// - 内容一致时不重复写入，减少无谓的文件改动。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, ".."); // tauri-app 根目录

// 唯一真源所在目录（与 tauri-app 平级的 py-test）。
// 可用环境变量 PY_SOURCE_DIR 覆盖。
const sourceDir = process.env.PY_SOURCE_DIR
  ? resolve(process.env.PY_SOURCE_DIR)
  : resolve(projectRoot, "..", "py-test");

// 需要同步的文件：{ from: 源文件名, to: 目标文件名 }
// 后续要共享更多脚本，往这里加即可。
const FILES = [
  { from: "release_version.py", to: "release_version.py" },
  { from: "wx_ribao.py", to: "wx_ribao.py" },
];

let synced = 0;
let skipped = 0;

for (const { from, to } of FILES) {
  const src = resolve(sourceDir, from);
  const dest = resolve(projectRoot, to);

  if (!existsSync(src)) {
    console.warn(
      `[sync-scripts] 跳过 ${from}：未找到源文件 ${src}（将使用已提交的副本）`
    );
    skipped++;
    continue;
  }

  const srcContent = readFileSync(src);
  const needsWrite =
    !existsSync(dest) || !readFileSync(dest).equals(srcContent);

  if (needsWrite) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, srcContent);
    console.log(`[sync-scripts] 已同步 ${from} -> ${dest}`);
    synced++;
  } else {
    console.log(`[sync-scripts] ${from} 已是最新，无需更新`);
  }
}

console.log(`[sync-scripts] 完成：更新 ${synced} 个，跳过 ${skipped} 个。`);
