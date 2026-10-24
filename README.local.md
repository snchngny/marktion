# ローカル変更メモ

## TabによるMarkdown階層編集

通常段落でTabを押すと、内容を標準Markdownのlist itemに変換します。直前が通常段落なら親itemへ変換し、現在段落をその子itemにします。直前に親候補がない場合はroot list itemを作ります。親がlist itemなら、そのmarkerの幅に合わせて子itemを作ります。複数行の段落は1 itemとして保ち、選択した連続list itemは同じ深さへ移動します。

複数cursorでは同じ通常段落への重複変換を一度にまとめ、選択したlist itemはまとめて階層変更します。別々の通常段落を含む一括選択は階層変換せず、従来のTab挿入処理を使います。

list item上のTabは直前の同階層itemの子へ移動します。Shift+Tabは1段上へ戻し、親の後ろに未選択の兄弟itemがある場合は、その兄弟の親を維持するため対象itemと子孫を親の残りの子孫の後ろへ移動します。root itemでShift+Tabを押すとmarkerを外し、子listは1段上へ移します。Markdownの段落とlistが続いて誤結合しないよう、必要な箇所には空行を入れます。最初のroot itemのTabは何も変更しません。

fenced/indented code、frontmatter、table、blockquoteでは通常の2 spacesを挿入します。read-only中またはIME変換中は階層変換しません。文書にはlist markerとindentだけを保存し、独自HTMLの階層記法は加えません。各操作は一つのUndoで戻せます。

この挙動はCodeMirrorの汎用indent commandを使いません。CodeMirrorの`indentMore`は選択行をindentし、Markdown専用コマンドはblock marker直後のBackspace処理を提供します。LogseqのMarkdown Mirrorは`-` itemとindentで親子を保存する設計です。Markraでは既存Lezer treeとBlockRange処理を使い、Markdown sourceを直接更新します。

- [CodeMirror commands](https://github.com/codemirror/commands)
- [CodeMirror Markdown language](https://github.com/codemirror/lang-markdown)
- [Logseq Markdown syntax](https://github.com/logseq/logseq/blob/master/docs/logseq-markdown-syntax.md)

## Callout解析の共有

`packages/editor/src/codemirror/callout-preview.ts`では、同じCodeMirror文書に対するCalloutの行走査結果を`WeakMap<Text, ...>`で共有します。spacing用StateFieldと表示用ViewPluginが別々に呼ばれても、同じ不変`Text`の間は1回だけ解析します。文書が変わると新しい`Text`をキーに解析し直します。選択・focus・viewport更新は文書を変えないため、再解析しません。

この変更は解析結果の再利用だけで、Calloutの認識条件、Decoration、文書内容、表示geometryは変えません。普通文字編集でも新しい文書全体を一度走査する点は残ります。range単位の再解析は今回含めていません。回帰テストはパーサ呼び出し数を数え、初期構築の重複排除、選択更新での再利用、文書更新後の再解析を確認します。別のrun-onlyベンチマークは固定100 KB/1 MB文書で選択を往復させ、パーサ呼び出し数とp50/p95時間をOS一時領域のJSONへ出します。実行はPowerShellで`$env:MARKRA_CALLOUT_BENCHMARK = '1'; pnpm --filter @markra/editor test -- src/codemirror/callout-preview.benchmark.test.ts`です。before/after比較では依存・OS・文書・反復数・warmupを揃え、baseline測定時だけ一時的にキャッシュget/setを外した同一ソースを使い、直後に実装を戻します。時間測定は環境差を含むため閾値にはせず、走査回数の回帰条件は通常テストで検査します。

CodeMirrorの公式説明では、`visibleRanges`による描画範囲の絞り込み、DecorationSetの変更マッピング、viewport算出前に必要な直接Decorationの制約を説明しています。Callout spacersはblock widgetで高さを変えるため、今回の変更はviewportで解析範囲を切らず、文書単位の解析結果を共有します。

- [CodeMirror Reference Manual](https://codemirror.net/docs/ref/)
- [CodeMirror System Guide](https://codemirror.net/docs/guide/)
- [CodeMirror Decoration Example](https://codemirror.net/examples/decoration/)

2026-10-24の同一環境での参考測定（5往復warmup後、20往復の選択変更）:

| 文書 | 変更前 p50 / p95 | 変更後 p50 / p95 | 選択更新中の解析呼出し |
| --- | --- | --- | --- |
| 100 KiB | 9.55 / 19.20 ms | 5.99 / 8.79 ms | 40 → 0 |
| 1 MiB | 52.93 / 125.94 ms | 3.83 / 17.01 ms | 40 → 0 |

jsdomのEditorView更新処理の単回比較です。画面描画完了までの入力遅延、ファイル読込、アプリ起動、サクラとの実機比較ではありません。計測JSONはOS一時領域の `markra-callout-benchmark-1792817669926.json`（変更前）、`markra-callout-benchmark-1792817692932.json`（変更後）です
