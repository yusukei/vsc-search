import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import {
  SearchParams,
  SearchResult,
  SearchResponse,
  FileContentResponse,
} from "./types";

export class SearchProvider {
  async search(params: SearchParams): Promise<SearchResponse> {
    const startTime = Date.now();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder || !params.query) {
      return { results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0 };
    }

    const searchDir = params.directory || "";
    const globPattern = new vscode.RelativePattern(
      workspaceFolder,
      searchDir ? `${searchDir}/**/*` : "**/*"
    );
    const excludePattern =
      "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.DS_Store}";

    const uris = await vscode.workspace.findFiles(globPattern, excludePattern);

    const regex = this.buildRegex(params);
    if (!regex) {
      return { results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0 };
    }

    const results: SearchResult[] = [];
    const matchingFiles = new Set<string>();

    await Promise.all(
      uris.map(async (uri) => {
        try {
          const content = await fs.readFile(uri.fsPath, "utf-8");
          // Skip likely binary files
          if (content.includes("\0")) {
            return;
          }
          const relativePath = vscode.workspace.asRelativePath(uri);
          const fileName = path.basename(uri.fsPath);
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            regex.lastIndex = 0;
            const match = regex.exec(line);
            if (match) {
              matchingFiles.add(relativePath);
              results.push({
                filePath: relativePath,
                fileName,
                lineNumber: i + 1,
                lineContent: line,
                column: match.index,
              });
            }
          }
        } catch {
          // Skip files that can't be read
        }
      })
    );

    results.sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber
    );

    return {
      results,
      fileCount: matchingFiles.size,
      totalHits: results.length,
      searchTimeMs: Date.now() - startTime,
    };
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

  private buildRegex(params: SearchParams): RegExp | null {
    try {
      let pattern: string;
      if (params.useRegex) {
        pattern = params.query;
      } else {
        pattern = params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      if (params.wholeWord) {
        pattern = `\\b${pattern}\\b`;
      }
      const flags = params.caseSensitive ? "g" : "gi";
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
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
