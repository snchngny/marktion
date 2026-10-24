# ローカル変更メモ

## TabによるMarkdown階層編集

構造の判定にはLezerの構文木を使います。コード内や段落の続きにあるlist風の文字列を子listと誤認して空行を入れず、コード本文を保持します。

通常段落でTabを押すと、内容を標準Markdownのlist itemに変換します。直前が通常段落なら親itemへ変換し、現在段落をその子itemにします。直前に親候補がない場合はroot list itemを作ります。親がlist itemなら、そのmarkerの幅に合わせて子itemを作ります。複数行の段落は1 itemとして保ち、選択した連続list itemは同じ深さへ移動します。

複数cursorでは同じ通常段落への重複変換を一度にまとめ、選択したlist itemはまとめて階層変更します。別々の通常段落を含む一括選択は階層変換せず、従来のTab挿入処理を使います。

list item上のTabは直前の同階層itemの子へ移動します。Shift+Tabは1段上へ戻し、親の後ろに未選択の兄弟itemがある場合は、その兄弟の親を維持するため対象itemと子孫を親の残りの子孫の後ろへ移動します。root itemでShift+Tabを押すとmarkerを外し、子listは1段上へ移します。Markdownの段落とlistが続いて誤結合しないよう、必要な箇所には空行を入れます。最初のroot itemのTabは何も変更しません。

fenced/indented code、frontmatter、table、blockquoteでは通常の2 spacesを挿入します。read-only中またはIME変換中は階層変換しません。文書にはlist markerとindentだけを保存し、独自HTMLの階層記法は加えません。各操作は一つのUndoで戻せます。

この挙動はCodeMirrorの汎用indent commandを使いません。CodeMirrorの`indentMore`は選択行をindentし、Markdown専用コマンドはblock marker直後のBackspace処理を提供します。LogseqのMarkdown Mirrorは`-` itemとindentで親子を保存する設計です。Markraでは既存Lezer treeとBlockRange処理を使い、Markdown sourceを直接更新します。

- [CodeMirror commands](https://github.com/codemirror/commands)
- [CodeMirror Markdown language](https://github.com/codemirror/lang-markdown)
- [Logseq Markdown syntax](https://github.com/logseq/logseq/blob/master/docs/logseq-markdown-syntax.md)

## Callout解析の共有

`packages/editor/src/codemirror/callout-preview.ts`では、同じCodeMirror文書に対するCalloutの行走査結果を`WeakMap<Text, ...>`で共有します。spacing用StateFieldと表示用ViewPluginが別々に呼ばれても、同じ不変`Text`の間は1回だけ解析します。本文変更時は下記の安全条件を満たす通常入力なら位置をmapし、それ以外は新しい`Text`をキーに解析し直します。選択・focus・viewport更新では再解析しません。

この変更では解析結果を文書単位で共有し、選択・focus・viewport更新での再解析を避けます。さらに通常本文の編集ではCallout位置とspacing Decorationを変更範囲に合わせてmapします。

CodeMirrorの公式説明では、`visibleRanges`による描画範囲の絞り込み、DecorationSetの変更マッピング、viewport算出前に必要な直接Decorationの制約を説明しています。Callout spacersはblock widgetで高さを変えるため、今回の変更はviewportで解析範囲を切らず、文書単位の解析結果を共有します。

- [CodeMirror Reference Manual](https://codemirror.net/docs/ref/)
- [CodeMirror System Guide](https://codemirror.net/docs/guide/)
- [CodeMirror Decoration Example](https://codemirror.net/examples/decoration/)

2026-10-24の同一環境での参考測定（5往復warmup後、20往復の選択変更）:

| 文書 | 変更前 p50 / p95 | 変更後 p50 / p95 | 選択更新中の解析呼出し |
| --- | --- | --- | --- |
| 100 KiB | 9.55 / 19.20 ms | 5.99 / 8.79 ms | 40 → 0 |
| 1 MiB | 52.93 / 125.94 ms | 3.83 / 17.01 ms | 40 → 0 |

jsdomのEditorView更新処理の単回比較です。画面描画完了までの入力遅延、ファイル読込、アプリ起動、サクラとの実機比較ではありません。計測JSONはOS一時領域の `markra-callout-benchmark-1792817669926.json`（変更前）、`markra-callout-benchmark-1792817692932.json`（変更後）です。

## Calloutの通常本文入力

既存アプリは1,000,000 bytes以上などの大文書をソース表示へ切り替えます。以下の1 MiB測定はこの制限を変更せず、エディタ単体へ負荷をかけた結果です。

編集前後のchanged lineがどちらもblockquoteではなく、変更内容に改行がない場合だけ、解析済みCallout位置とspacing Decorationをtransaction changesでmapします。通常本文の入力・削除では全文の行走査を行いません。quote内の編集、blockquoteの生成・削除、改行は従来どおり全文を解析します。安全条件を狭く保ち、Callout markerやquote continuationの検査を局所mapの対象外にしています。

回帰テストでは空Callout一覧、複数rangeの同時変更、Unicode挿入と削除、quote本文編集、blockquote生成、改行挿入を確認します。通常本文入力ベンチマークは固定100 KiB/1 MiB文書（Callout後に多数の短い段落）、5回warmup後30回の文字挿入・削除pairを計測し、parser呼出数とp50/p95時間をOS一時領域のJSONへ出します。既存の選択移動ベンチマークも維持します。

PowerShellから`packages/editor`を作業directoryにして入力計測を実行します。

```powershell
$env:MARKRA_CALLOUT_INPUT_BENCHMARK = '1'
pnpm exec vitest run --environment jsdom --globals src/codemirror/callout-preview.benchmark.test.ts
```

変更前後の比較は同一runtimeとfixtureで行い、変更前だけcommit `1581e81`のCallout実装へ一時的に戻して測定後、変更版へ復元します。変更前後とも5 warmup後30回の挿入・削除pairです。

2026-10-24の同一環境での参考測定:

| 文書 | 変更前 p50 / p95 | 変更後 p50 / p95 | 解析呼出し |
| --- | --- | --- | --- |
| 100 KiB | 5.27 / 8.98 ms | 2.89 / 4.60 ms | 60 → 0 |
| 1 MiB | 33.45 / 49.16 ms | 1.95 / 3.51 ms | 60 → 0 |

計測JSONはOS一時領域の`markra-callout-input-benchmark-1792819090453.json`（変更前）、`markra-callout-input-benchmark-1792819062252.json`（変更後）です。時間値はjsdomのEditorView更新を測る参考値であり、画面描画完了までの入力遅延、ファイル読込、起動時間、サクラとの実機比較ではありません。時間閾値は設けず、通常本文入力時の解析呼出数が0になることを回帰条件にします。
