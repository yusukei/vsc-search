import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const MARKER_START = "<!-- !! VSC-SEARCH-START !! -->";
const MARKER_END = "<!-- !! VSC-SEARCH-END !! -->";
const BACKUP_SUFFIX = ".vsc-search.backup";
const INJECT_DIR = "vsc-search";

// Relative paths from the directory containing "vs/" folder
const WORKBENCH_CANDIDATES = [
  "vs/code/electron-sandbox/workbench/workbench.html",
  "vs/code/electron-browser/workbench/workbench.html",
];

function getBaseDirectories(): string[] {
  const dirs: string[] = [];

  // 1. Walk up from require.main.filename to find a dir containing "vs/"
  const mainFilename = require.main?.filename ?? "";
  if (mainFilename) {
    let dir = path.dirname(mainFilename);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(dir, "vs"))) {
        dirs.push(dir);
        break;
      }
      dir = path.dirname(dir);
    }
  }

  // 2. vscode.env.appRoot (e.g. /Applications/Visual Studio Code.app/Contents/Resources/app)
  const appRoot = vscode.env.appRoot;
  if (appRoot) {
    dirs.push(appRoot);
    // On macOS/Linux, workbench.html is under {appRoot}/out/
    dirs.push(path.join(appRoot, "out"));
  }

  return dirs;
}

function findWorkbenchHtml(): string | null {
  const bases = getBaseDirectories();
  for (const base of bases) {
    for (const candidate of WORKBENCH_CANDIDATES) {
      const fullPath = path.join(base, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function getBackupPath(htmlPath: string): string {
  return htmlPath + BACKUP_SUFFIX;
}

function getInjectDir(htmlPath: string): string {
  return path.join(path.dirname(htmlPath), INJECT_DIR);
}

export function isPatchInstalled(): boolean {
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) {
    return false;
  }
  try {
    const content = fs.readFileSync(htmlPath, "utf-8");
    return content.includes(MARKER_START);
  } catch {
    return false;
  }
}

export function needsRepatch(): boolean {
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) {
    return false;
  }
  const backupPath = getBackupPath(htmlPath);
  // Backup exists (was previously patched) but marker is gone (VS Code updated)
  return fs.existsSync(backupPath) && !isPatchInstalled();
}

export async function install(
  extensionPath: string
): Promise<{ success: boolean; message: string }> {
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) {
    return {
      success: false,
      message:
        "workbench.html が見つかりません。VS Code のインストールパスを確認してください。",
    };
  }

  try {
    const content = fs.readFileSync(htmlPath, "utf-8");

    // Injection block
    // highlighter.js sets window.__vscSearchHighlighter (must load before modal.js)
    // modal.js connects to Extension Host via WebSocket
    const injection = [
      MARKER_START,
      `<link rel="stylesheet" href="${INJECT_DIR}/modal.css" />`,
      `<script src="${INJECT_DIR}/highlighter.js"></script>`,
      `<script src="${INJECT_DIR}/modal.js"></script>`,
      MARKER_END,
    ].join("\n");

    // Already patched — update files AND refresh HTML injection block
    if (content.includes(MARKER_START)) {
      copyInjectedFiles(extensionPath, htmlPath);
      const re = new RegExp(
        `${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`
      );
      let updated = patchCSP(content);
      updated = updated.replace(re, injection);
      fs.writeFileSync(htmlPath, updated, "utf-8");
      return { success: true, message: "パッチを更新しました。VS Code を再起動してください。" };
    }

    // Create backup
    const backupPath = getBackupPath(htmlPath);
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(htmlPath, backupPath);
    }

    // Copy injected files
    copyInjectedFiles(extensionPath, htmlPath);

    // Patch CSP to allow HTTP connections to localhost bridge
    let patched = patchCSP(content);
    patched = patched.replace("</html>", `${injection}\n</html>`);
    fs.writeFileSync(htmlPath, patched, "utf-8");

    return {
      success: true,
      message: "パッチを適用しました。VS Code を再起動してください。",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("EACCES") || msg.includes("EPERM")) {
      return {
        success: false,
        message: `権限エラー: VS Code のインストールディレクトリへの書き込み権限がありません。\n${htmlPath}`,
      };
    }
    return { success: false, message: `パッチ適用に失敗しました: ${msg}` };
  }
}

export async function uninstall(): Promise<{
  success: boolean;
  message: string;
}> {
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) {
    return { success: false, message: "workbench.html が見つかりません。" };
  }

  try {
    const backupPath = getBackupPath(htmlPath);

    if (fs.existsSync(backupPath)) {
      // Restore from backup
      fs.copyFileSync(backupPath, htmlPath);
      fs.unlinkSync(backupPath);
    } else {
      // No backup, try to remove markers manually
      const content = fs.readFileSync(htmlPath, "utf-8");
      const re = new RegExp(
        `\\n?${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`,
        "g"
      );
      const cleaned = content.replace(re, "");
      fs.writeFileSync(htmlPath, cleaned, "utf-8");
    }

    // Remove injected files directory
    const injectDir = getInjectDir(htmlPath);
    if (fs.existsSync(injectDir)) {
      fs.rmSync(injectDir, { recursive: true, force: true });
    }

    return {
      success: true,
      message: "パッチを削除しました。VS Code を再起動してください。",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `パッチ削除に失敗しました: ${msg}` };
  }
}

function copyInjectedFiles(extensionPath: string, htmlPath: string): void {
  const srcDir = path.join(extensionPath, "dist", "injected");
  const destDir = getInjectDir(htmlPath);

  fs.mkdirSync(destDir, { recursive: true });

  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
}

function patchCSP(content: string): string {
  let result = content;

  // Add http://127.0.0.1:* if not present
  if (!result.includes("http://127.0.0.1:*")) {
    result = result.replace(
      /(connect-src\s+[^;]*)/,
      "$1 http://127.0.0.1:*"
    );
  }

  // Add ws://127.0.0.1:* if not present
  if (!result.includes("ws://127.0.0.1:*")) {
    result = result.replace(
      /(connect-src\s+[^;]*)/,
      "$1 ws://127.0.0.1:*"
    );
  }

  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
