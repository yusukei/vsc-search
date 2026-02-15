import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { install, uninstall, isPatchInstalled, needsRepatch } from "./patcher";
import { SearchProvider } from "./searchProvider";
import { WsBridge } from "./wsServer";

let bridge: WsBridge | null = null;
let nonceStatusBarItem: vscode.StatusBarItem | null = null;

// --- Inject directory discovery (same logic as patcher) ---

function findWorkbenchHtml(): string | null {
  const candidates = [
    "vs/code/electron-sandbox/workbench/workbench.html",
    "vs/code/electron-browser/workbench/workbench.html",
  ];
  const dirs: string[] = [];
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
  const appRoot = vscode.env.appRoot;
  if (appRoot) {
    dirs.push(appRoot);
    dirs.push(path.join(appRoot, "out"));
  }
  for (const base of dirs) {
    for (const c of candidates) {
      const full = path.join(base, c);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function getInjectDir(): string | null {
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) return null;
  return path.join(path.dirname(htmlPath), "vsc-search");
}

// --- bridges.json management ---

interface BridgeEntry {
  nonce: string;
  port: number;
  pid: number;
  timestamp: number;
}

function readBridgesJson(injectDir: string): BridgeEntry[] {
  const filePath = path.join(injectDir, "bridges.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) return entries;
  } catch {}
  return [];
}

function writeBridgesJson(injectDir: string, entries: BridgeEntry[]): void {
  const filePath = path.join(injectDir, "bridges.json");
  fs.mkdirSync(injectDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registerBridge(injectDir: string, nonce: string, port: number): void {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  let entries = readBridgesJson(injectDir);

  // Remove stale entries
  entries = entries.filter((e) => {
    if (e.pid === process.pid) return false; // Remove own previous entry
    if (now - e.timestamp > maxAge) return false; // Too old
    if (!isProcessAlive(e.pid)) return false; // Dead process
    return true;
  });

  // Add own entry
  entries.push({ nonce, port, pid: process.pid, timestamp: now });
  writeBridgesJson(injectDir, entries);
}

function unregisterBridge(injectDir: string): void {
  let entries = readBridgesJson(injectDir);
  entries = entries.filter((e) => e.pid !== process.pid);
  writeBridgesJson(injectDir, entries);
}

function writeFastPathJson(injectDir: string, windowId: number, port: number): void {
  const filePath = path.join(injectDir, `bridge-w${windowId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ port }), "utf-8");
}

function removeFastPathJson(injectDir: string, windowId: number): void {
  const filePath = path.join(injectDir, `bridge-w${windowId}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

// --- Explorer selection detection (clipboard workaround) ---

async function getExplorerSelection(): Promise<vscode.Uri | undefined> {
  try {
    // Save current clipboard content
    const savedClipboard = await vscode.env.clipboard.readText();

    // Use a unique marker to detect if copyFilePath actually copied something
    const marker = `__vsc_search_marker_${Date.now()}__`;
    await vscode.env.clipboard.writeText(marker);

    // Execute copyFilePath — copies the focused explorer item's path
    await vscode.commands.executeCommand("copyFilePath");

    // Read what was copied
    const copiedPath = await vscode.env.clipboard.readText();

    // Restore original clipboard
    await vscode.env.clipboard.writeText(savedClipboard);

    // If clipboard still has our marker, nothing was copied
    if (!copiedPath || copiedPath === marker) {
      return undefined;
    }

    const uri = vscode.Uri.file(copiedPath);

    // Check if it's a directory or file
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        return uri;
      }
      // If it's a file, use its parent directory
      return vscode.Uri.joinPath(uri, "..");
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

// --- Activation ---

export function activate(context: vscode.ExtensionContext) {
  const workerPath = path.join(context.extensionPath, "dist", "searchWorker.js");
  const searchProvider = new SearchProvider(workerPath);
  context.subscriptions.push({ dispose: () => searchProvider.dispose() });
  const injectDir = getInjectDir();

  // Check if patch needs to be re-applied (after VS Code update)
  if (needsRepatch()) {
    vscode.window
      .showWarningMessage(
        "vsc-search: VS Code が更新されたため、パッチの再適用が必要です。",
        "再適用"
      )
      .then((selection) => {
        if (selection === "再適用") {
          vscode.commands.executeCommand("vsc-search.enablePatch");
        }
      });
  }

  // --- Nonce for status bar DOM verification ---
  const nonce = Math.random().toString(36).slice(2, 10);
  nonceStatusBarItem = vscode.window.createStatusBarItem(
    "vsc-search-verify",
    vscode.StatusBarAlignment.Right,
    -9999
  );
  nonceStatusBarItem.text = `vsc-s:${nonce}`;
  nonceStatusBarItem.name = "vsc-search-verify";
  nonceStatusBarItem.tooltip = "vsc-search bridge verification";
  nonceStatusBarItem.show();
  context.subscriptions.push(nonceStatusBarItem);

  // --- WebSocket bridge ---

  bridge = new WsBridge(async (method, params) => {
    const p = params as Record<string, unknown>;
    switch (method) {
      case "search":
        return searchProvider.search(p as never);

      case "getFileContent":
        try {
          return await searchProvider.getFileContent(p.filePath as string);
        } catch {
          return { content: "", languageId: "plaintext" };
        }

      case "openFile": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        const uri = vscode.Uri.joinPath(
          workspaceFolder.uri,
          p.filePath as string
        );
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const line = ((p.lineNumber as number) || 1) - 1;
        const col = (p.column as number) || 0;
        const pos = new vscode.Position(line, col);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
        return;
      }

      case "pickFolder": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return null;
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: workspaceFolder.uri,
          openLabel: "Select Folder",
        });
        if (uris && uris.length > 0) {
          return vscode.workspace.asRelativePath(uris[0]);
        }
        return null;
      }

      default:
        throw new Error("Unknown method: " + method);
    }
  }, nonce);

  bridge
    .start()
    .then((port) => {
      console.log("[vsc-search] Bridge started on port " + port);

      // Write bridges.json for renderer discovery
      if (injectDir) {
        try {
          registerBridge(injectDir, nonce, port);
          console.log("[vsc-search] Registered in bridges.json");
        } catch (e) {
          console.error("[vsc-search] Failed to write bridges.json:", e);
        }
      }
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[vsc-search] Failed to start bridge:", msg);
      vscode.window.showErrorMessage("vsc-search: ブリッジ起動失敗: " + msg);
    });

  // When client verifies, write fast-path json and hide nonce
  const checkVerified = setInterval(() => {
    if (bridge?.isConnected && bridge.windowId != null) {
      clearInterval(checkVerified);

      // Write fast-path json for quick reconnection
      if (injectDir) {
        try {
          writeFastPathJson(injectDir, bridge.windowId, bridge.listeningPort);
        } catch {}
      }

      // Hide nonce from status bar
      if (nonceStatusBarItem) {
        nonceStatusBarItem.hide();
      }

      console.log(`[vsc-search] Connection verified (windowId=${bridge.windowId})`);
    }
  }, 500);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(checkVerified);

      // Clean up fast-path json
      if (injectDir && bridge?.windowId != null) {
        removeFastPathJson(injectDir, bridge.windowId);
      }

      // Unregister from bridges.json
      if (injectDir) {
        try {
          unregisterBridge(injectDir);
        } catch {}
      }

      bridge?.stop();
      bridge = null;
    },
  });

  // --- Patch management commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("vsc-search.enablePatch", async () => {
      const result = await install(context.extensionPath);
      if (result.success) {
        const action = await vscode.window.showInformationMessage(
          result.message,
          "再起動"
        );
        if (action === "再起動") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vsc-search.disablePatch", async () => {
      const result = await uninstall();
      if (result.success) {
        const action = await vscode.window.showInformationMessage(
          result.message,
          "再起動"
        );
        if (action === "再起動") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  // --- Main command: trigger modal ---

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vsc-search.searchInDirectory",
      async (uri?: vscode.Uri) => {
        if (!isPatchInstalled()) {
          const action = await vscode.window.showWarningMessage(
            "vsc-search: パッチが適用されていません。先にパッチを適用してください。",
            "パッチを適用"
          );
          if (action === "パッチを適用") {
            vscode.commands.executeCommand("vsc-search.enablePatch");
          }
          return;
        }

        let targetUri = uri;

        // If no URI from context menu (keyboard shortcut), try to get explorer selection
        if (!targetUri) {
          targetUri = await getExplorerSelection();
        }

        // Fallback to active editor's parent directory
        if (!targetUri) {
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && !activeEditor.document.isUntitled) {
            targetUri = vscode.Uri.joinPath(activeEditor.document.uri, "..");
          }
        }

        const directory = targetUri
          ? vscode.workspace.asRelativePath(targetUri)
          : undefined;

        if (!bridge?.isConnected) {
          vscode.window.showWarningMessage(
            "vsc-search: レンダラーとの接続がありません。VS Code を再起動してください。"
          );
          return;
        }

        bridge.notify("showModal", { directory });
      }
    )
  );
}

export function deactivate() {
  bridge?.stop();
  bridge = null;
}
