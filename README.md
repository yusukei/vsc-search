# vsc-search

VS Code 拡張機能。ワークスペース内のファイル検索をフローティングモーダル UI で提供します。JetBrains 系 IDE の「Find in Files」に近い操作感を実現します。

## 機能

- フローティングモーダルによるファイル内検索（`Ctrl+Shift+F` / `Cmd+Shift+F`）
- リアルタイム検索（デバウンス付き）
- 大文字/小文字区別・単語単位マッチ・正規表現の切り替え
- シンタックスハイライト付きプレビュー
- エクスプローラーの右クリックメニューからフォルダ指定検索
- モーダルのリサイズ対応
- Worker Thread による非同期検索

## UI

```
┌──────────────────────────────────────────────────────────┐
│ [検索入力欄                         ] [Cc] [W] [.*]      │
│ [ディレクトリ入力欄                 ]      5件/3ファイル   │
├──────────────────────────────────────────────────────────┤
│ public void ToggleDoorState()          ModelManager.cs:42 │
│ public void ToggleDecal1()              DebugModel.cs:95  │
│ public void ToggleDecal2()              DebugModel.cs:100 │
├──────────────────────────────────────────────────────────┤
│  41 │                                                     │
│▶42 │     public void ToggleDoorState()                   │
│  43 │     {                                               │
└──────────────────────────────────────────────────────────┘
```

## インストール

### 前提条件

- VS Code 1.85.0 以上
- Node.js（Volta 推奨）

### ビルド・インストール

```bash
npm install
npm run build
npm run package   # .vsix を生成
```

生成された `.vsix` を VS Code にインストールします:

```
code --install-extension vsc-search-0.0.1.vsix
```

### パッチの適用

初回起動後、コマンドパレットから以下を実行します:

```
vsc-search: Enable (Patch VS Code)
```

VS Code の `workbench.html` にスクリプト注入のパッチを適用し、再起動を促します。

> **注意:** パッチ適用後「インストールが破損しています」の警告が表示されますが、動作に問題はありません。

## 使い方

### キーボードショートカット

| キー | 動作 |
|------|------|
| `Ctrl+Shift+F` / `Cmd+Shift+F` | モーダルを開く |
| 文字入力 | リアルタイム検索 |
| `↑` / `↓` | 結果リストの選択移動 |
| `Enter` / ダブルクリック | ファイルをエディタで開く |
| `Escape` | モーダルを閉じる（状態は保持） |

### コンテキストメニュー

エクスプローラーでフォルダを右クリック → **Search in Directory** で、そのフォルダを対象にした検索モーダルが開きます。

## アーキテクチャ

```
Extension Host (Node.js)          Renderer (DOM)
┌─────────────────────┐           ┌──────────────────────┐
│ extension.ts        │           │ bootstrap.js         │
│ searchProvider.ts   │◄─ WS ──► │ modal.js / modal.css │
│ searchWorker.ts     │           │ highlighter.js       │
│ wsServer.ts         │           └──────────────────────┘
│ patcher.ts          │
└─────────────────────┘
```

- **Extension Host ↔ Renderer 間通信:** WebSocket + DOM nonce 検証
- **検索処理:** Worker Thread で非同期実行
- **DOM 注入:** `workbench.html` への直接パッチ（`iocave.monkey-patch` 不要）

### 主要ファイル

| ファイル | 役割 |
|----------|------|
| `src/extension.ts` | エントリポイント、WsBridge 管理、nonce ステータスバー |
| `src/wsServer.ts` | WebSocket サーバー（WsBridge クラス） |
| `src/patcher.ts` | workbench.html CSP パッチ |
| `src/searchProvider.ts` | 検索ロジック |
| `src/searchWorker.ts` | Worker Thread による検索実行 |
| `injected/modal.js` | Renderer 側 WebSocket クライアント + UI |
| `injected/modal.css` | モーダルスタイル（VS Code テーマ変数使用） |
| `injected/bootstrap.js` | Renderer 側ブートストラップ |
| `injected/highlighter.js` | シンタックスハイライト |

## コマンド

| コマンド | 説明 |
|----------|------|
| `vsc-search: Search in Directory` | 検索モーダルを開く |
| `vsc-search: Enable (Patch VS Code)` | パッチを適用 |
| `vsc-search: Disable (Restore VS Code)` | パッチを解除 |

## ライセンス

[MIT](LICENSE)
