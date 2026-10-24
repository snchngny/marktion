# marktion

Markdownをそのまま保存できるデスクトップエディターです。[Markra](https://github.com/markrahq/markra)を基に、Markdown/GFM入力・Tabによる階層編集・複数ブロックの移動を拡張しています

## ダウンロード

正式版はこのrepoのReleasesから取得できます。開発版はActionsの「Windows build」で成功した実行を開き、`marktion-windows-x64-<commit>`をダウンロードしてください。Actionsの成果物取得にはGitHubへのログインが必要です

Windows x64用の`marktion.exe`、NSISインストーラー、対応ソース、ライセンス、SHA256SUMSを配布します。実行ファイルとインストーラーは未署名です。既存Markraとはアプリ識別子を分けています

## 主な操作

| 操作 | キー・方法 |
| --- | --- |
| 次の段落／段落内改行 | Enter／Shift+Enter |
| 階層を下げる／上げる | Tab／Shift+Tab。通常段落はMarkdownのリストへ変換 |
| ブロック選択 | Esc、Shift+↑/↓で選択を拡張 |
| 複数ブロックの移動 | 範囲選択後にCtrl+Shift+↑/↓、または選択群のハンドルをドラッグ |
| ドラッグの挿入位置 | 移動先行の上半分でブロックの前、下半分で後 |
| タスクの作成／切替 | 行頭で`[]`＋空白／Ctrl+Enter |
| 形式変換 | `/`コマンド、ブロック選択中はCtrl+/ |
| 保存／Undo／Redo | Ctrl+S／Ctrl+Z／Ctrl+Shift+Z |

上記のブロック操作は視覚編集面で使います。複数行の段落は全体が移動単位です。リスト項目群は同じ親・深さの兄弟を対象とし、異なる親・深さやリストと通常段落を混ぜた群の移動には制限があります。Markdownの表現を越えるNotionのデータベース・共有権限・同期機能は実装していません

Markdownが文書の正本です。通常のファイル編集と、利用者が設定するAI・Web検索・辞書ダウンロード等の通信機能を備えています。AIを使うときは選択した接続先へ入力内容が送信されます

## 開発

Node.js 24、pnpm 10.30.3、Rust stable、Tauri v2のOS別ビルド要件が必要です

```sh
pnpm install --frozen-lockfile
pnpm --filter @markra/editor test
pnpm --filter @markra/desktop build
pnpm tauri build --bundles nsis -- --locked
```

最後のコマンドはWindows向けです。開発サーバーは`pnpm dev`、デスクトップ開発起動は`pnpm tauri dev`です。内部workspace名`@markra/*`とRustのlibrary名は元の構成を維持しています

mainへのpush・pull request・手動実行でGitHub ActionsがWindows版をビルドします。`v*`タグをpushすると、ビルド成功後に同じ成果物と対応ソースをGitHub Releaseへ登録します。署名秘密鍵は不要です。上流MarkraのRelease・WinGet・更新配布先へは公開しません。自動更新用の署名・endpointは未設定です

## 元プロジェクトとライセンス

marktionはMarkra contributorsによる[Markra](https://github.com/markrahq/markra)の派生です。元プロジェクトのGit履歴と著作権表記を保持しています。初期派生元はMarkra 2.14.0です

ライセンスは元プロジェクトと同じ[AGPL-3.0-only](LICENSE)です。配布するバイナリには、このrepoの該当commitの対応ソースを添付します。第三者ライブラリ・フォント等にはそれぞれのライセンスが適用されます
