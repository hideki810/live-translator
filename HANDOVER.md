# HANDOVER — live-translator

最終更新: 2026-11-20

## 概要
音声翻訳Webアプリ（ブラウザ版＋Android APK）。GitHub: hideki810/live-translator

## 置き場所
- 正本: GitHubリポジトリ `hideki810/live-translator`（main）
- VM作業コピー: Muse VM `~/workspace/apk-build/app`（git clone、origin接続済み）
- 配布: Googleドライブに `live-translator.apk`（v2）
- プロジェクト指示: `CLAUDE.md` ／ 実機検証の記録: `TESTING.md` ／ 変更履歴: `CHANGELOG.md`

## 済んだこと
- CLAUDE.mdの点検と実機検証ログのTESTING.md分離（2026-11-15、コミット fd201ce / e724f76）
- Android APK v2 を作成し、Googleドライブで配布

## 残っていること
- Galaxy Z Fold8 での音声認識の実機確認（結果未報告）。WebViewでは音声認識が動かない可能性あり
- 動かない場合の次善策: 別端末（PC Chrome / iPad Safari）で認識テスト

## 決定事項
- 有料の音声認識サービスへの切替は「現時点では無し」（2026-11-15 Hideki決定）。再提案しない

## 引き継ぎルール
- 同じファイルを複数環境で同時編集しない。作業前に正本（GitHub）の最新を取り、終わったらpushして状態を揃える
- 進捗が変わったらこのファイルを更新する
