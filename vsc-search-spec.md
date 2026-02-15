# vsc-search 仕様書

## 概要

VS Code拡張機能。ワークスペース内の指定ディレクトリ以下を対象としたファイル内検索を提供する。`iocave.monkey-patch` を利用してVS CodeのDOM上にフローティングモーダルを直接注入し、JetBrains系IDEの「Find in Files」に近いUIを実現する。

---

## 方式

### Monkey Patch（iocave.monkey-patch 依存）

- `iocave.monkey-patch` 拡張を前提依存とする
- `package.json` の `contributes.configuration` にて注入するJS/CSSファイルを宣言
- 注入スクリプトがVS CodeのメインウィンドウDOM上で実行され、`document.body` にフローティングモーダルの `<div>` を追加する
- `position: fixed` + 高 `z-index` で他のUI要素の上に浮かぶ

### トレードオフ（許容済み）

- VS Codeの内部DOM構造に依存するため、アップデートで壊れる可能性がある
- 初回有効化時に「インストールが破損しています」の警告が出る
- Marketplace公開時に審査で不利になる可能性がある

---

## UI構成

画面中央にオーバーレイ表示されるフローティングモーダル。3つのセクションで構成される。

### レイアウト

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 [検索入力欄                    ] [Cc] [W] [.*]       │
│ 📁 [ディレクトリ入力欄            ]           5件/3ファイル │
├──────────────────────────────────────────────────────────┤
│ public void ToggleDoorState()          ModelManager.cs:42│
│ ServerRpc.Instance.ToggleDoorStateRpc…  ModelManager.cs:44│
│ public void ToggleDecal1()              DebugModel.cs:95 │
│ public void ToggleDecal2()              DebugModel.cs:100│
│ public void ToggleDoorState()           DebugModel.cs:118│
├──────────────────────────────────────────────────────────┤
│  40 │     }                                              │
│  41 │                                                    │
│▶42 │     public void ToggleDoorState()                  │
│  43 │     {                                              │
│  44 │         ServerRpc.Instance.ToggleDoorStateRpc();   │
│  45 │     }                                              │
│  46 │ }                                                  │
└──────────────────────────────────────────────────────────┘
```

### 1. 検索バー（上部）

- テキスト入力欄（自動フォーカス）
- トグルボタン: 大文字/小文字区別 (Cc)、単語単位マッチ (W)、正規表現 (.\*)
- ディレクトリ指定欄（ワークスペース相対パス、フォルダ選択ボタン付き）
- ヒット件数・ファイル数の表示（例: 「37ファイル / 109件」）

### 2. 検索結果リスト（中央）

- 各行の表示形式: `マッチ行のコード内容` + 右寄せで `ファイル名:行番号`
- キーワード部分をハイライト表示
- キーボード（↑↓）で選択行を移動可能
- シングルクリック → プレビュー領域（下部）に該当箇所を表示
- ダブルクリック or Enter → VS Codeのエディタタブで該当ファイル・行を開き、モーダルを閉じる

### 3. プレビュー領域（下部）

- 選択した検索結果の該当ファイルをインラインプレビュー
- シンタックスハイライト付き（shiki等のハイライトライブラリを使用）
- 検索キーワードのハイライト表示
- 該当行が中央付近に来るようスクロール
- 行番号表示あり
- Read-only

---

## 検索仕様

| 項目 | 仕様 |
|------|------|
| 検索対象 | ワークスペース内の指定ディレクトリ以下の全ファイル |
| 検索トリガー | デバウンス付きリアルタイム検索（入力停止後 300ms 程度） |
| 大文字/小文字区別 | トグルで切替（デフォルト: OFF） |
| 単語単位マッチ | トグルで切替（デフォルト: OFF） |
| 正規表現 | トグルで切替（デフォルト: OFF） |
| ファイルマスク | なし（全ファイル対象） |
| 結果上限 | なし（全件列挙） |
| 想定規模 | 数百ファイル程度 |

### 検索エンジン

Extension Host側で `vscode.workspace.findFiles` + `fs.readFile` によるパターンマッチを行い、結果を注入スクリプト側に `postMessage` 等で送信する。

---

## 操作フロー

### コマンドパレットから起動

1. コマンドパレット → `vsc-search: Search in Directory` またはキーバインド
2. フローティングモーダルが画面中央に表示される
3. 前回のディレクトリ・検索文字列・結果が復元される
4. 検索文字列を入力 → リアルタイムで結果更新
5. 結果を選択 → プレビュー領域に表示
6. ダブルクリック or Enter → エディタで開きモーダルを閉じる
7. ESC → モーダルを閉じる（状態は保持）

### コンテキストメニューから起動

1. エクスプローラーでフォルダを右クリック
2. 「Search in This Folder」を選択
3. 右クリックしたフォルダがディレクトリ欄にセットされた状態でモーダルが開く

---

## キーボード操作

| キー | 動作 |
|------|------|
| 文字入力 | 検索（デバウンス付き） |
| ↑ / ↓ | 検索結果リストの選択行を移動（プレビューも連動更新） |
| Enter | 選択中の結果をVS Codeエディタで開き、モーダルを閉じる |
| Escape | モーダルを閉じる（状態は保持） |
| ダブルクリック | 結果行をVS Codeエディタで開き、モーダルを閉じる |
| シングルクリック | 結果行をプレビュー領域に表示 |

---

## 状態管理

| 項目 | 保持タイミング |
|------|----------------|
| 検索文字列 | セッション中（モーダルを閉じて再度開いても復元） |
| 指定ディレクトリ | セッション中 |
| 検索結果 | セッション中 |
| トグル状態（Cc, W, .\*） | セッション中 |
| 選択行インデックス | セッション中 |
| VS Code再起動後 | リセット（保持しない） |

※コンテキストメニューからの起動時は、ディレクトリのみ上書きされる。

---

## 技術構成

```
vsc-search/
├── package.json              # 拡張マニフェスト（monkey-patch設定含む）
├── tsconfig.json
├── src/
│   ├── extension.ts          # Extension Host側エントリポイント
│   │                         #   - コマンド登録、コンテキストメニュー
│   │                         #   - 検索ロジック実行
│   │                         #   - 注入スクリプトとのメッセージング
│   ├── searchProvider.ts     # 検索ロジック（ファイル走査、パターンマッチ）
│   └── searchState.ts        # 状態管理（セッション中の保持）
├── injected/
│   ├── modal.js              # DOM注入スクリプト（フローティングUI構築・操作）
│   ├── modal.css             # モーダルのスタイル（VS Codeテーマ変数使用）
│   └── highlighter.js        # シンタックスハイライト処理
└── README.md
```

### 通信フロー

```
[Extension Host (TypeScript)]          [注入スクリプト (DOM)]
        │                                       │
        │  ← コマンド発火 (open/setDirectory)    │
        │                                       │
        │  ← 検索リクエスト (query, options) ──  │
        │                                       │
        │  ── 検索結果 (results[]) ──→           │
        │                                       │
        │  ← ファイル内容リクエスト (filePath) ── │
        │                                       │
        │  ── ファイル内容 (content) ──→          │
        │                                       │
        │  ← ファイルを開く (filePath, line) ──  │
        │                                       │
```

Extension Host ↔ 注入スクリプト間の通信は、VS Code内部のブロードキャストチャンネルまたはカスタムイベントを使用する。

### 主要技術要素

| 要素 | 技術 |
|------|------|
| DOM注入基盤 | `iocave.monkey-patch` |
| フローティングUI | `position: fixed` の `<div>` を `document.body` に追加 |
| テーマ連動 | CSS変数 `var(--vscode-*)` |
| シンタックスハイライト | shiki（軽量、多言語対応）または簡易トークナイザ |
| 検索ロジック | `vscode.workspace.findFiles` + `fs.readFile` |
| ファイルを開く | `vscode.window.showTextDocument` |

---

## package.json（monkey-patch設定）

```jsonc
{
  "name": "vsc-search",
  "displayName": "vsc-search",
  "extensionDependencies": [
    "iocave.monkey-patch"
  ],
  "contributes": {
    "commands": [
      {
        "command": "vsc-search.searchInDirectory",
        "title": "Search in Directory",
        "category": "vsc-search"
      }
    ],
    "menus": {
      "explorer/context": [
        {
          "command": "vsc-search.searchInDirectory",
          "when": "explorerResourceIsFolder",
          "group": "4_search"
        }
      ]
    },
    "configuration": {
      "type": "object",
      "title": "vsc-search",
      "properties": {
        "vsc-search.monkeyPatch": {
          "type": "object",
          "default": {
            "scripts": ["injected/modal.js"],
            "styles": ["injected/modal.css"]
          }
        }
      }
    }
  }
}
```

---

## 将来の拡張候補

- スコープ切り替え（ワークスペース全体 / プロジェクト / ディレクトリ）
- ファイルマスク（拡張子やglobパターンによるフィルタ）
- 置換機能
- 検索履歴
- ブックマーク（検索結果の保存）
- モーダルのリサイズ・ドラッグ移動
