import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { Worker } from "worker_threads";
import {
  SearchParams,
  SearchResponse,
  FileContentResponse,
  WorkerToMainMessage,
} from "./types";

const WORKER_TIMEOUT_MS = 30_000;

export class SearchProvider {
  private worker: Worker;
  private workerPath: string;
  private searchId = 0;
  private currentCts: vscode.CancellationTokenSource | null = null;
  private pendingSearch: {
    searchId: number;
    resolve: (resp: SearchResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(workerPath: string) {
    this.workerPath = workerPath;
    this.worker = this.spawnWorker();
  }

  private spawnWorker(): Worker {
    console.log("[vsc-search] Spawning worker:", this.workerPath);
    const w = new Worker(this.workerPath);
    w.on("online", () => {
      console.log("[vsc-search] Worker online");
    });
    w.on("message", (msg: WorkerToMainMessage) => this.onWorkerMessage(msg));
    w.on("error", (err) => {
      console.error("[vsc-search] Worker error:", err);
    });
    w.on("exit", (code) => {
      console.error(
        `[vsc-search] Worker exited with code ${code}, restarting...`
      );
      if (this.pendingSearch) {
        clearTimeout(this.pendingSearch.timeout);
        this.pendingSearch.resolve({
          results: [],
          fileCount: 0,
          totalHits: 0,
          searchTimeMs: 0,
        });
        this.pendingSearch = null;
      }
      this.worker = this.spawnWorker();
    });
    return w;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const startTime = Date.now();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder || !params.query) {
      return { results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0, truncated: false };
    }

    // Cancel any in-flight findFiles
    if (this.currentCts) {
      this.currentCts.cancel();
      this.currentCts.dispose();
      this.currentCts = null;
    }

    // Cancel any pending worker search
    this.cancelCurrentSearch();

    const searchId = ++this.searchId;
    const cts = new vscode.CancellationTokenSource();
    this.currentCts = cts;

    // findFiles on main thread
    const searchDir = params.directory || "";
    const globPattern = new vscode.RelativePattern(
      workspaceFolder,
      searchDir ? `${searchDir}/**/*` : "**/*"
    );

    const defaultExcludes = [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.DS_Store",
    ];
    const excludes = searchDir
      ? defaultExcludes.filter((pattern) => {
          const dir = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
          return !searchDir.startsWith(dir) && !searchDir.includes("/" + dir);
        })
      : defaultExcludes;
    const excludePattern =
      excludes.length > 0 ? `{${excludes.join(",")}}` : undefined;

    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        globPattern,
        excludePattern,
        undefined,
        cts.token
      );
    } catch {
      cts.dispose();
      this.currentCts = null;
      return { results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0, truncated: false };
    }

    // Check if superseded during findFiles
    if (this.searchId !== searchId) {
      cts.dispose();
      return { results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0, truncated: false };
    }

    this.currentCts = null;
    cts.dispose();

    const filePaths = uris.map((u) => u.fsPath);
    const relativePaths = uris.map((u) => vscode.workspace.asRelativePath(u));

    console.log(
      `[vsc-search] findFiles returned ${uris.length} URIs, posting to worker (searchId=${searchId})`
    );

    // Post to worker and await result (with timeout)
    return new Promise<SearchResponse>((resolve) => {
      const wrappedResolve = (resp: SearchResponse) => {
        resolve({ ...resp, searchTimeMs: Date.now() - startTime });
      };

      const timeout = setTimeout(() => {
        console.error("[vsc-search] Worker search timed out");
        if (this.pendingSearch?.searchId === searchId) {
          this.worker.postMessage({ type: "abort", searchId });
          this.pendingSearch = null;
          wrappedResolve({
            results: [],
            fileCount: 0,
            totalHits: 0,
            searchTimeMs: 0,
          });
        }
      }, WORKER_TIMEOUT_MS);

      this.pendingSearch = { searchId, resolve: wrappedResolve, timeout };

      this.worker.postMessage({
        type: "search",
        searchId,
        filePaths,
        relativePaths,
        params,
      });
    });
  }

  private cancelCurrentSearch(): void {
    if (this.pendingSearch) {
      const { searchId, resolve, timeout } = this.pendingSearch;
      clearTimeout(timeout);
      this.worker.postMessage({ type: "abort", searchId });
      resolve({ results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0, truncated: false });
      this.pendingSearch = null;
    }
  }

  private onWorkerMessage(msg: WorkerToMainMessage): void {
    console.log(
      `[vsc-search] Worker message: type=${msg.type}, searchId=${msg.searchId}, pending=${this.pendingSearch?.searchId}`
    );
    if (!this.pendingSearch) return;
    if (msg.searchId !== this.pendingSearch.searchId) return;

    const { resolve, timeout } = this.pendingSearch;
    this.pendingSearch = null;
    clearTimeout(timeout);

    switch (msg.type) {
      case "result":
        resolve({
          results: msg.results,
          fileCount: msg.fileCount,
          totalHits: msg.totalHits,
          searchTimeMs: 0,
          truncated: msg.truncated,
        });
        break;
      case "aborted":
        resolve({ results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0, truncated: false });
        break;
      case "error":
        console.error("[vsc-search] Worker search error:", msg.message);
        resolve({ results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0, truncated: false });
        break;
    }
  }

  dispose(): void {
    if (this.currentCts) {
      this.currentCts.cancel();
      this.currentCts.dispose();
      this.currentCts = null;
    }
    this.cancelCurrentSearch();
    this.worker.terminate();
  }

  async getFileContent(filePath: string): Promise<FileContentResponse> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { content: "", languageId: "plaintext" };
    }

    const fullPath = path.join(workspaceFolder.uri.fsPath, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    const ext = path.extname(filePath).toLowerCase();
    const languageId = this.getLanguageId(ext);

    return { content, languageId };
  }

  private getLanguageId(ext: string): string {
    const map: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".cs": "csharp",
      ".py": "python",
      ".java": "java",
      ".rs": "rust",
      ".go": "go",
      ".rb": "ruby",
      ".css": "css",
      ".html": "html",
      ".json": "json",
      ".md": "markdown",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".xml": "xml",
      ".sh": "shellscript",
      ".c": "c",
      ".cpp": "cpp",
      ".h": "c",
      ".hpp": "cpp",
      ".lua": "lua",
      ".swift": "swift",
      ".kt": "kotlin",
    };
    return map[ext] || "plaintext";
  }
}
