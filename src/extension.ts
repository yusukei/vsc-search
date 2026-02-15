import * as vscode from "vscode";
import { install, uninstall, isPatchInstalled, needsRepatch } from "./patcher";
import { SearchProvider } from "./searchProvider";
import { HttpBridge } from "./wsServer";

let bridge: HttpBridge | null = null;

export function activate(context: vscode.ExtensionContext) {
  const searchProvider = new SearchProvider();

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

  // --- HTTP bridge ---

  bridge = new HttpBridge(async (method, params) => {
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
  });

  bridge
    .start()
    .then((port) => {
      console.log("[vsc-search] Bridge started on port " + port);
      vscode.window.showInformationMessage(
        "vsc-search: ブリッジ起動 (port " + port + ")"
      );
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[vsc-search] Failed to start bridge:", msg);
      vscode.window.showErrorMessage("vsc-search: ブリッジ起動失敗: " + msg);
    });

  context.subscriptions.push({
    dispose: () => {
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

        const directory = uri
          ? vscode.workspace.asRelativePath(uri)
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
