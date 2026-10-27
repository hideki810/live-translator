# 会議ライブ翻訳 — 開発メモ

介護施設の会議で、日本語の発言をリアルタイムで英語など7言語に訳し続けるWebアプリ。外国人スタッフがiPad/スマホの画面で読む。
利用者（持ち主）はプログラミングの専門家ではないので、説明は日本語で、専門用語を避けて書く。

## 構成
- `index.html` 1ファイルだけで動く（ビルドなし）。`main` に push すると GitHub Pages（https://hideki810.github.io/live-translator/ ）に1〜2分で反映される。
- 音声認識：ブラウザの Web Speech API（`ja-JP`）。iPad/iPhoneはSafari、AndroidはChromeが前提。
- 翻訳：Google翻訳の非公式窓口（`translate.googleapis.com ... client=gtx`）。失敗したら1分間 MyMemory に切り替え。APIキーは使わない。

## これまでに決めたこと
- **高精度モード（Claude API）は持ち主の判断で撤去した。** 頼まれない限り、有料APIやAPIキー入力を戻さない。
- 認識の部品（SpeechRecognition）は**常に1つだけ**。新しく作る前に `killRec()` で古いものの受け口を外してから止める。2つ同時に動くと片方がマイクをつかんだまま固まり、「途中で聞き取らなくなる」原因になった。
- 見張り役（2秒ごと）：止まっている／起動の合図が5秒来ない／認識中なのに20秒何も届かない、のどれかで作り直す。
- Android版Chromeは連続モードで同じ文が重複して届くため、`continuous=false` で1文ごとに区切ってすぐ再開する。5秒以内の同じ文は1回にまとめる。
- iPad/iPhoneは確定（isFinal）が来ないことがあるので、1.8秒の無音か120文字で区切って確定し、認識を作り直す。
- 診断情報には会議の中身（話した文）を入れない。出来事と時刻だけ。
- 開閉する欄は `hidden` 属性で隠す。CSSで `display` を指定すると `hidden` が効かなくなるので、`[hidden]{display:none!important}` を消さない（v1.3.0で診断の欄が開きっぱなしになった）。

## 変更するときの手順
1. `index.html` を直す。挙動を変えたら `VERSION`（`index.html` 内）と `package.json` の版を上げ、`CHANGELOG.md` に書く。
2. `npm test`（`tests/simulate.test.js`）を流す。にせの音声認識で12項目を確かめる。新しい不具合を直したら、それを再現するテストも足す。
   クラウド環境では Playwright と Chromium が入っているので `node tests/simulate.test.js` で動く。
3. `main` に push すると公開される。持ち主には実機での確認を `TESTING.md` の手順でお願いする。
- 自動テストは本物のマイク・本物の端末を確かめられない。実機で確かめていないことは、確かめていないと伝える。

## 持ち主からの不具合報告
画面の「診断」ボタンでコピーした文章が貼られてくることがある。`onend` / `onerror` / `watchdog` の並びと秒数を見て、どこで止まったかを調べる。
