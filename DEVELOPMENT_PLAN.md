# vsc-search 開発計画

## 概要

VS Code拡張機能「vsc-search」の開発計画。ワークスペース内の指定ディレクトリ以下を対象としたファイル内検索をフローティングモーダルで提供し、JetBrains系IDEの「Find in Files」に近いUIを実現する。

### 方式変更

仕様書では`iocave.monkey-patch`を前提依存としていたが、同拡張は**2022年10月以降メンテナンス停止**であり、VS Code 1.74以降での互換性問題が確認された。代替として**APC Customize UI++のパッチ方式を参考にした自前パッチ方式**を採用する。

---

## 1. アーキテクチャ決定

### 1.1 DOM注入方式: 自前パッチ（APC参考）

`iocave.monkey-patch`に依存せず、拡張自身がVS Codeの内部ファイルを直接パッチしてRendererプロセスにカスタムスクリプトを注入する。

#### パッチ対象ファイル

APC Customize UI++のソースコード分析に基づく。

| ファイル | パス | パッチ内容 |
|----------|------|-----------|
| `workbench.html` | `{appRoot}/vs/code/electron-sandbox/workbench/workbench.html` | カスタム`<script>`タグを挿入。注入スクリプトをWorkbench初期化前にロード |

**最小パッチアプローチ**: vscode-custom-cssと同様に、`workbench.html`への`<script>`タグ挿入のみで実現する。APC のようなAMDモジュールインターセプトは行わず、よりシンプルなアプローチを取る。

#### パッチ方法

```
1. VS Codeインストールディレクトリの workbench.html を読み取り
2. バックアップ作成（.vsc-search.backup）
3. </html> の前にカスタム <script> タグと <link> タグを挿入
4. VS Code再起動で適用
```

挿入するコード:
```html
<!-- !! VSC-SEARCH-START !! -->
<link rel="stylesheet" href="vsc-search/modal.css" />
<script src="vsc-search/modal.js"></script>
<!-- !! VSC-SEARCH-END !! -->
```

**注**: 注入スクリプトは`workbench.html`と同じディレクトリ内の`vsc-search/`サブフォルダに配置する。

### 1.2 通信方式

注入スクリプトはRendererプロセスのグローバルスコープで実行される。Extension Host（Node.jsプロセス）との通信には**VS CodeのICommandService**を使用する。

#### InstantiationServiceフック

APC方式に従い、VS Code内部の`InstantiationService`コンストラクタをフックして`ICommandService`を取得する。

```javascript
// workbench.js のロード後、VS Codeの AMD モジュールシステムが利用可能
// require() で内部モジュールにアクセス
require(['vs/platform/instantiation/common/instantiationService'], function(mod) {
  // InstantiationService のコンストラクタをラップ
  // APC の findInPrototype パターンでmanglingに対応
  var origClass = findClassWithMethod(mod, 'createInstance');

  class WrappedInstantiationService extends origClass {
    constructor() {
      super(...arguments);
      initVscSearch(this);
    }
  }

  // 元のエクスポートを差し替え
  replaceExport(mod, origClass, WrappedInstantiationService);
});

function initVscSearch(instantiationService) {
  var commandService = instantiationService.invokeFunction(function(accessor) {
    return accessor.get(/* ICommandService */);
  });
  // commandService を使って Extension Host と通信
}
```

**重要**: VS Code 1.74以降、TypeScript private field manglingにより内部クラス名が変更される。APCの`findInPrototype`パターンに従い、**クラス名ではなくメソッドシグネチャ（`createInstance`等）で検索**する。

#### 通信フロー

```
Extension Host (Node.js)                    Renderer Process (注入スクリプト)
        │                                              │
        │  registers: vsc-search._search               │
        │  registers: vsc-search._getFileContent       │
        │  registers: vsc-search._openFile             │
        │  registers: vsc-search._pickFolder           │
        │                                              │
        │                       registers: vsc-search._showModal
        │                       registers: vsc-search._hideModal
        │                                              │
        │  [コマンド発火: searchInDirectory]            │
        │  → executeCommand('_showModal', {dir, state}) │
        │ ──────────────────────────────────────────→   │
        │                                              │ モーダル表示
        │                                              │
        │                                              │ [ユーザー入力]
        │                                              │ → _search(params)
        │ ←──────────────────────────────────────────   │
        │  findFiles + readFile + match                │
        │  return SearchResponse                       │
        │ ──────────────────────────────────────────→   │
        │                                              │ 結果描画
        │                                              │
        │                                              │ [結果選択]
        │                                              │ → _getFileContent(path)
        │ ←──────────────────────────────────────────   │
        │  readFile → return content                   │
        │ ──────────────────────────────────────────→   │
        │                                              │ プレビュー描画
        │                                              │
        │                                              │ [Enter/ダブルクリック]
        │                                              │ → _openFile(path, line)
        │ ←──────────────────────────────────────────   │
        │  showTextDocument                            │
```

- **Renderer → Extension Host**: `commandService.executeCommand()` でコマンド呼び出し。戻り値はPromiseで受信。JSON直列化可能なデータのみ受け渡し可能
- **Extension Host → Renderer**: `vscode.commands.executeCommand()` でRenderer側登録コマンドを呼び出し
- **フォールバック**: Extension Host→Renderer方向が動作しない場合、`vscode.workspace.getConfiguration`の変更通知を利用

### 1.3 ビルドツール

| 対象 | ツール | 出力 |
|------|--------|------|
| Extension Host (`src/*.ts`) | esbuild | `dist/extension.js`（CommonJS） |
| 注入スクリプト (`injected/*`) | コピーのみ | パッチ時にVS Codeインストールディレクトリにコピー |

### 1.4 シンタックスハイライト

Reactモック内のC#トークナイザを多言語対応の簡易トークナイザに汎用化する。

### 1.5 状態管理

Renderer側（注入スクリプトのclosure変数）が正。Extension Hostは状態を持たない。

| 状態項目 | 保持場所 | 保持期間 |
|----------|----------|----------|
| 検索文字列 | Renderer | セッション中 |
| 指定ディレクトリ | Renderer | セッション中 |
| トグル状態（Cc, W, .*） | Renderer | セッション中 |
| 検索結果 | Renderer | セッション中 |
| 選択行インデックス | Renderer | セッション中 |
| プレビューキャッシュ | Renderer | セッション中 |

---

## 2. プロジェクト構成

```
vsc-search/
├── package.json              # 拡張マニフェスト（コマンド、メニュー、キーバインド）
├── tsconfig.json             # TypeScript設定（ES2020, CommonJS）
├── esbuild.mjs               # ビルドスクリプト（バンドル + コピー）
├── .vscodeignore              # パッケージ除外設定
├── src/
│   ├── extension.ts          # Extension Hostエントリポイント
│   │                         #   - パッチ管理（インストール/アンインストール/更新検知）
│   │                         #   - コマンド登録（_search, _getFileContent, _openFile, _pickFolder）
│   │                         #   - 検索ロジック呼び出し
│   ├── patcher.ts            # VS Codeファイルパッチャー
│   │                         #   - workbench.html の検出・バックアップ・パッチ・復元
│   │                         #   - 注入スクリプトのコピー
│   │                         #   - パッチ状態チェック
│   ├── searchProvider.ts     # 検索エンジン
│   │                         #   - vscode.workspace.findFiles によるファイル列挙
│   │                         #   - fs.readFile + RegExpによるパターンマッチ
│   └── types.ts              # TypeScriptインターフェース
├── injected/
│   ├── modal.js              # 注入スクリプト: DOM注入、UI構築、通信ブリッジ
│   │                         #   - InstantiationServiceフック
│   │                         #   - ICommandServiceブリッジ
│   │                         #   - フローティングモーダルDOM構築
│   │                         #   - 状態管理（closure変数）
│   ├── modal.css             # モーダルスタイル（var(--vscode-*)テーマ連動）
│   └── highlighter.js        # シンタックスハイライト（簡易多言語トークナイザ）
├── vsc-search-spec.md        # 仕様書
└── vsc-search-mock.jsx       # UIモック（React）
```

### ファイル間の依存関係

```
extension.ts
  ├→ patcher.ts（パッチ管理）
  ├→ searchProvider.ts（検索ロジック）
  └→ types.ts（型定義）

patcher.ts
  → injected/* を VS Codeインストールディレクトリにコピー
  → workbench.html にスクリプト参照を挿入

modal.js (Renderer Process, パッチ適用後にロード)
  → vs/platform/instantiation/common/instantiationService（VS Code内部AMD）
  → highlighter.js（シンタックスハイライト、動的import or inline）
```

---

## 3. 実装フェーズ

### Phase 1: プロジェクトスキャフォールディング + パッチャー

**目標**: パッチャーが`workbench.html`を正しくパッチし、注入スクリプトがRendererで実行されることを確認する。

#### 作成ファイル

| ファイル | 内容 |
|----------|------|
| `package.json` | 拡張マニフェスト: コマンド定義（searchInDirectory, enablePatch, disablePatch）、メニュー、キーバインド |
| `tsconfig.json` | TypeScript設定 |
| `esbuild.mjs` | ビルドスクリプト |
| `.vscodeignore` | パッケージ除外設定 |
| `src/extension.ts` | 最小実装: パッチ管理コマンド登録 |
| `src/patcher.ts` | パッチャー: workbench.html検出、バックアップ、パッチ、復元 |
| `injected/modal.js` | 最小スクリプト: `console.log("[vsc-search] injected!")` |
| `injected/modal.css` | 空ファイル |

#### パッチャー実装詳細（`src/patcher.ts`）

```typescript
// 主要関数

// VS Codeインストールディレクトリのworkbench.htmlを検出
function findWorkbenchHtml(): string
  // path.dirname(require.main!.filename) でインストールパス取得
  // 候補:
  //   {appRoot}/vs/code/electron-sandbox/workbench/workbench.html
  //   {appRoot}/vs/code/electron-browser/workbench/workbench.html

// パッチ状態チェック
function isPatchInstalled(): boolean
  // workbench.htmlに "VSC-SEARCH-START" マーカーが存在するか

// パッチ適用
async function install(extensionPath: string): Promise<void>
  // 1. workbench.htmlのバックアップ作成（.vsc-search.backup）
  // 2. 注入スクリプトをworkbench.htmlと同じディレクトリの vsc-search/ にコピー
  //    extensionPath/injected/modal.js → {workbenchDir}/vsc-search/modal.js
  //    extensionPath/injected/modal.css → {workbenchDir}/vsc-search/modal.css
  //    extensionPath/injected/highlighter.js → {workbenchDir}/vsc-search/highlighter.js
  // 3. workbench.htmlの </html> 前にスクリプト参照を挿入
  //    <!-- !! VSC-SEARCH-START !! -->
  //    <link rel="stylesheet" href="vsc-search/modal.css" />
  //    <script src="vsc-search/modal.js"></script>
  //    <!-- !! VSC-SEARCH-END !! -->
  // 4. 「VS Codeの再起動が必要」通知

// パッチ削除
async function uninstall(): Promise<void>
  // 1. バックアップからworkbench.htmlを復元
  // 2. vsc-search/ ディレクトリを削除
  // 3. 「VS Codeの再起動が必要」通知

// VS Codeアップデート検知
function needsRepatch(): boolean
  // workbench.htmlにマーカーが存在しない（アップデートで上書きされた）
```

#### package.json コマンド

```jsonc
{
  "contributes": {
    "commands": [
      {
        "command": "vsc-search.searchInDirectory",
        "title": "Search in Directory",
        "category": "vsc-search"
      },
      {
        "command": "vsc-search.enablePatch",
        "title": "Enable (Patch VS Code)",
        "category": "vsc-search"
      },
      {
        "command": "vsc-search.disablePatch",
        "title": "Disable (Restore VS Code)",
        "category": "vsc-search"
      }
    ]
  }
}
```

#### 検証手順

1. `npm install` → `npm run build`
2. F5でExtension Development Hostを起動
3. コマンドパレット → `vsc-search: Enable (Patch VS Code)` を実行
4. 「再起動が必要」通知 → VS Codeを再起動
5. DevToolsコンソール → `[vsc-search] injected!` が表示されることを確認
6. コマンドパレット → `vsc-search: Disable (Restore VS Code)` → 再起動 → ログが消えることを確認

---

### Phase 2: 通信ブリッジ確立（最高リスク）

**目標**: Extension Host ↔ 注入スクリプト間で双方向コマンド通信が動作することを確認する。

#### 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `injected/modal.js` | InstantiationServiceフック、ICommandService取得、`_showModal`コマンド登録、テスト通信 |
| `src/extension.ts` | `_ping`テストコマンド登録、`searchInDirectory`から`_showModal`呼び出し |

#### 実装詳細

**注入スクリプト側（`modal.js`）**:

```javascript
(function() {
  'use strict';

  // VS Code の AMD require が利用可能になるまで待機
  // workbench.js がロードされた後に内部モジュールにアクセス可能
  var initAttempts = 0;
  var maxAttempts = 50;

  function tryInit() {
    initAttempts++;
    if (typeof require === 'undefined' || !require.defined) {
      if (initAttempts < maxAttempts) {
        setTimeout(tryInit, 100);
      }
      return;
    }

    require([
      'vs/platform/instantiation/common/instantiationService',
      'vs/platform/commands/common/commands'
    ], function(instantiationMod, commandsMod) {
      hookInstantiationService(instantiationMod, commandsMod);
    });
  }

  function findClassWithMethod(mod, methodName) {
    // APCのfindInPrototypeパターン: mangling対応
    for (var key in mod) {
      var val = mod[key];
      if (typeof val === 'function' && val.prototype &&
          typeof val.prototype[methodName] === 'function') {
        return { key: key, cls: val };
      }
    }
    // prototypeチェーンも探索
    for (var key in mod) {
      var val = mod[key];
      if (typeof val === 'function' && val.prototype) {
        for (var prop in val.prototype) {
          if (prop === methodName ||
              (typeof val.prototype[prop] === 'function' &&
               prop.includes && prop.includes(methodName))) {
            return { key: key, cls: val };
          }
        }
      }
    }
    return null;
  }

  function hookInstantiationService(instantiationMod, commandsMod) {
    var found = findClassWithMethod(instantiationMod, 'createInstance');
    if (!found) {
      console.error('[vsc-search] InstantiationService not found');
      return;
    }

    var OrigClass = found.cls;
    var initialized = false;

    class PatchedInstantiationService extends OrigClass {
      constructor() {
        super(...arguments);
        if (!initialized) {
          initialized = true;
          try {
            initVscSearch(this, commandsMod);
          } catch(e) {
            console.error('[vsc-search] init failed:', e);
          }
        }
      }
    }

    instantiationMod[found.key] = PatchedInstantiationService;
  }

  function initVscSearch(instantiationService, commandsMod) {
    // ICommandService を DI コンテナから取得
    var commandService;
    try {
      instantiationService.invokeFunction(function(accessor) {
        // ICommandService の serviceId を検索
        commandService = accessor.get(commandsMod.ICommandService);
      });
    } catch(e) {
      console.error('[vsc-search] Failed to get ICommandService:', e);
      return;
    }

    // Renderer側コマンド登録
    commandsMod.CommandsRegistry.registerCommand(
      'vsc-search._showModal',
      function(accessor, args) {
        showModal(args);
      }
    );

    // テスト: Extension Host側コマンド呼び出し
    commandService.executeCommand('vsc-search._ping').then(function(result) {
      console.log('[vsc-search] ping:', result);
    }).catch(function(e) {
      console.error('[vsc-search] ping failed:', e);
    });

    // commandServiceをグローバルに保存（他の関数から利用）
    window.__vscSearchCommandService = commandService;

    console.log('[vsc-search] communication bridge initialized');
  }

  // モーダル表示（Phase 4で実装）
  function showModal(args) {
    console.log('[vsc-search] showModal:', args);
  }

  // 初期化開始
  tryInit();
})();
```

**Extension Host側（`extension.ts`）**:

```typescript
// テスト用pingコマンド
context.subscriptions.push(
  vscode.commands.registerCommand('vsc-search._ping', () => {
    return { message: 'pong', timestamp: Date.now() };
  })
);

// モーダル起動コマンド
context.subscriptions.push(
  vscode.commands.registerCommand('vsc-search.searchInDirectory', async (uri?: vscode.Uri) => {
    const directory = uri ? vscode.workspace.asRelativePath(uri) : undefined;
    try {
      await vscode.commands.executeCommand('vsc-search._showModal', { directory });
    } catch {
      // フォールバック: Configuration変更通知
      await vscode.workspace.getConfiguration('vsc-search').update(
        '_trigger',
        JSON.stringify({ action: 'show', directory, ts: Date.now() }),
        vscode.ConfigurationTarget.Global
      );
    }
  })
);
```

#### 検証手順

1. パッチ適用 → VS Code再起動
2. DevToolsコンソール: `[vsc-search] ping: { message: 'pong', ... }` を確認（Renderer → Host）
3. コマンドパレット → `vsc-search: Search in Directory` → `[vsc-search] showModal: ...` を確認（Host → Renderer）
4. エクスプローラーでフォルダ右クリック → ディレクトリ付きで呼ばれることを確認

#### リスク対策

| リスク | 対策 |
|--------|------|
| `require()`でAMDモジュールにアクセスできない | `<script>`をworkbench.jsのロード後に実行するか、MutationObserverで`require`の可用性を監視 |
| InstantiationServiceのクラス名がmanglingで変わる | `findClassWithMethod`でメソッドシグネチャベースの検索 |
| Host→Renderer通信が動作しない | Configuration変更通知フォールバック |
| ICommandServiceのserviceIdが取得できない | `commandsMod`の全プロパティを探索してServiceIdentifierを見つける |

---

### Phase 3: 検索エンジン

**目標**: 検索クエリ+ディレクトリ+オプションで正確な検索結果を返す。

#### 作成ファイル

| ファイル | 内容 |
|----------|------|
| `src/types.ts` | `SearchParams`, `SearchResult`, `SearchResponse`, `FileContentResponse` |
| `src/searchProvider.ts` | 検索ロジック |

#### 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/extension.ts` | `_search`, `_getFileContent`, `_openFile`, `_pickFolder`コマンド登録 |

#### データ型定義

```typescript
interface SearchParams {
  query: string;
  directory: string;          // ワークスペース相対パス
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

interface SearchResult {
  filePath: string;           // ワークスペース相対パス
  fileName: string;
  lineNumber: number;         // 1始まり
  lineContent: string;
  column: number;             // 0始まり
}

interface SearchResponse {
  results: SearchResult[];
  fileCount: number;
  totalHits: number;
  searchTimeMs: number;
}

interface FileContentResponse {
  content: string;
  languageId: string;         // "csharp", "typescript" 等
}
```

#### 検索ロジック

```
searchProvider.search(params):
  1. ワークスペースフォルダ取得
  2. findFiles(directory/**/*) でファイルURI一覧取得
     除外: node_modules, .git, dist, build
  3. RegExp構築（useRegex/wholeWord/caseSensitive対応）
  4. 各ファイル並列読み取り（Promise.all）
     - バイナリファイルはcatchで無視
     - 行ごとにRegExpテスト
  5. ファイルパス→行番号順でソート
  6. SearchResponse返却
```

#### 登録コマンド

| コマンド | 方向 | 用途 |
|----------|------|------|
| `vsc-search._search` | Renderer → Host | 検索実行 |
| `vsc-search._getFileContent` | Renderer → Host | ファイル内容取得 |
| `vsc-search._openFile` | Renderer → Host | エディタでファイルを開く |
| `vsc-search._pickFolder` | Renderer → Host | フォルダ選択ダイアログ |

---

### Phase 4: モーダルUI構築

**目標**: フローティングモーダルの全UIをDOM構築し、検索コマンドと接続する。

#### 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `injected/modal.js` | 全DOM構築、イベントハンドリング、検索連携 |
| `injected/modal.css` | 全スタイル定義 |

#### UI要素

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 [検索入力欄(自動フォーカス)      ] [Cc] [W] [.*]       │
│ 📁 [ディレクトリ入力欄    ] [📂]         N件 / Nファイル    │
├──────────────────────────────────────────────────────────┤
│ マッチ行内容（ハイライト付き）           ファイル名:行番号  │
│ ▶ 選択行（背景色変更）                 ファイル名:行番号  │
│ マッチ行内容（ハイライト付き）           ファイル名:行番号  │
├──────────────────────────────────────────────────────────┤
│ ファイルパス表示バー                                      │
│  行番号 │ コード（シンタックスハイライト）                  │
│ ▶行番号 │ マッチ行（キーワードハイライト + 左ボーダー）     │
│  行番号 │ コード（シンタックスハイライト）                  │
├──────────────────────────────────────────────────────────┤
│ ↑↓ 移動　Enter 開く　Esc 閉じる                          │
└──────────────────────────────────────────────────────────┘
```

#### スタイリング

VS CodeのCSS変数でテーマ連動:

| UI要素 | CSS変数 |
|--------|---------|
| モーダル背景 | `--vscode-editorWidget-background` |
| モーダル枠線 | `--vscode-editorWidget-border` |
| 入力欄背景 | `--vscode-input-background` |
| フォーカス枠線 | `--vscode-focusBorder` |
| 選択行背景 | `--vscode-list-activeSelectionBackground` |
| ホバー行背景 | `--vscode-list-hoverBackground` |
| 検索ハイライト | `--vscode-editor-findMatchHighlightBackground` |
| プレビュー背景 | `--vscode-editor-background` |
| エディタフォント | `--vscode-editor-font-family` |

#### キーボード操作

| キー | 動作 |
|------|------|
| 文字入力 | デバウンス付き検索（300ms） |
| ↑ / ↓ | 結果リスト選択移動 + プレビュー連動 |
| Enter | 選択行をエディタで開く + モーダル閉じる |
| Escape | モーダル閉じる（状態保持） |
| ダブルクリック | 結果行をエディタで開く + モーダル閉じる |
| シングルクリック | 結果行を選択 + プレビュー表示 |

#### フォルダ選択ボタン

📂ボタン → `_pickFolder`コマンド → Extension Hostで`showOpenDialog`実行 → 結果をRendererに返却

---

### Phase 5: プレビューパネル + シンタックスハイライト

**目標**: 選択結果のファイルコンテキストをシンタックスハイライト付きで表示する。

#### 作成ファイル

| ファイル | 内容 |
|----------|------|
| `injected/highlighter.js` | 多言語対応の簡易トークナイザ |

#### トークナイザ

| トークン | 色（Dark+準拠） | 判定 |
|----------|-----------------|------|
| キーワード | `#569cd6` | 言語別キーワードセット |
| 文字列 | `#ce9178` | `"..."`, `'...'`, `` `...` `` |
| コメント | `#6a9955` | `//...`, `#...` |
| 数値 | `#b5cea8` | `[0-9]`始まり |
| 型名 | `#4ec9b0` | 大文字始まり識別子 |
| 識別子 | `#9cdcfe` | その他 |

対応言語: C#, TypeScript/JavaScript, Python, Java, Go, Rust, デフォルト

#### プレビュー描画

マッチ行の前後8行を表示。マッチ行はキーワードハイライト + 行番号横に黄色ボーダー。同一ファイル内の移動ではキャッシュを利用しスクロールのみ。

---

### Phase 6: ポリッシュ + エッジケース

**目標**: 仕様書の全操作パターンを網羅し、エッジケースを処理する。

#### 対応項目

| カテゴリ | 項目 | 対応 |
|----------|------|------|
| パッチ | VS Codeアップデート検知 | activate時にマーカー存在チェック、なければ再パッチ通知 |
| パッチ | 権限エラー | macOS/Linuxはsudo不要（ユーザーインストール）。システムインストール時はエラーメッセージ |
| パフォーマンス | 検索キャンセル | リクエストIDでstale結果を破棄 |
| エラー処理 | 空ワークスペース | モーダル内にメッセージ |
| エラー処理 | バイナリファイル | readFileのcatchで無視 |
| エラー処理 | 不正な正規表現 | 空結果返却 |
| UI | 長い行 | CSS `text-overflow: ellipsis` |
| UI | 空結果 | 「一致する結果がありません」メッセージ |

---

## 4. フェーズ依存関係

```
Phase 1: スキャフォールディング + パッチャー
    │
    ▼
Phase 2: 通信ブリッジ（GO/NO-GOゲート）
    │
    ▼
Phase 3: 検索エンジン
    │
    ▼
Phase 4: モーダルUI
    │
    ▼
Phase 5: プレビュー + シンタックスハイライト
    │
    ▼
Phase 6: ポリッシュ + エッジケース
```

---

## 5. リスクと対策

| リスク | 影響度 | 発生確率 | 対策 |
|--------|--------|----------|------|
| workbench.htmlのパス・構造変更 | 高 | 中 | 複数候補パスの探索、マーカーベースのパッチで構造依存を最小化 |
| TypeScript private field mangling | 高 | 確定 | メソッドシグネチャベースの検索（APCパターン） |
| Host→Renderer通信が動作しない | 高 | 中 | Configuration変更通知フォールバック |
| VS Codeアップデートでパッチが消える | 中 | 高 | activate時に自動検知、再パッチ通知 |
| ファイルシステム権限エラー | 中 | 低 | エラーメッセージ + 権限変更手順の案内 |
| 「インストールが破損しています」警告 | 低 | 確定 | 仕様書で許容済み。無視設定の案内 |

---

## 6. 検証方法

各フェーズごとにExtension Development Host（F5）で動作確認:

1. **Phase 1**: パッチ適用 → 再起動 → DevToolsコンソールで注入確認 → パッチ削除 → 再起動 → 注入なし確認
2. **Phase 2**: ping通信確認（双方向）、コマンドパレット・右クリックからのモーダルトリガー確認
3. **Phase 3**: DevToolsからの直接コマンド実行で検索結果確認
4. **Phase 4**: モーダル表示→検索→結果選択→ファイルを開く一連のフロー
5. **Phase 5**: プレビューにシンタックスハイライトが適用される確認
6. **Phase 6**: エッジケース + VS Codeアップデートシミュレーション

---

## 7. 技術参考

| 参考 | 用途 |
|------|------|
| [drcika/apc-extension](https://github.com/drcika/apc-extension) | 自前パッチ方式の参考実装（InstantiationServiceフック、AMDモジュールインターセプト） |
| [be5invis/vscode-custom-css](https://marketplace.visualstudio.com/items?itemName=be5invis.vscode-custom-css) | workbench.htmlパッチの参考（シンプルなHTML注入パターン） |
| [subframe7536/vscode-custom-ui-style](https://github.com/subframe7536/vscode-custom-ui-style) | バックアップ・復元パターンの参考 |
| [iocave/customize-ui](https://github.com/iocave/customize-ui) | InstantiationServiceフックの元祖パターン（アーカイブ済み） |
| [VS Code Extension API](https://code.visualstudio.com/api) | コマンド登録、ファイル操作、エディタAPI |
| `vsc-search-spec.md` | 機能仕様書 |
| `vsc-search-mock.jsx` | UIモック（React実装） |
