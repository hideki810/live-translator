// 本物のマイクの代わりに「にせの音声認識」を使って、アプリの動きを自動で確かめるテスト。
// 実行: npm test   （Playwright と Chromium が必要）
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
// 「パソコン（Linux）」と名乗る Android タブレットの Chrome（実機の録画で確認した形）
const DESKTOP_LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// にせの音声認識と翻訳を差し込む。translate=fail で Google 翻訳の失敗をまねる
function fakes({ noSR = false, googleFails = false } = {}) {
  return ({ noSR, googleFails }) => {
    window.__recs = [];
    window.__urls = [];
    class FakeSR {
      constructor() { window.__recs.push(this); this.state = 'new'; }
      start() {
        if (window.__recs.filter(r => r.state === 'live').length) window.__twoLive = true;
        this.state = 'live';
        if (window.__deny) {   // マイクを最初から断られた場合をまねる
          setTimeout(() => { this.onerror && this.onerror({ error: 'not-allowed' }); this.state = 'dead'; this.onend && this.onend(); }, 10);
          return;
        }
        setTimeout(() => this.onstart && this.onstart(), 10);
      }
      abort() { this.state = 'dead'; setTimeout(() => this.onend && this.onend(), 10); }
      stop() { this.abort(); }
    }
    window.__live = () => window.__recs.filter(r => r.state === 'live');
    if (noSR) { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; }
    else { window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR; }
    window.fetch = async u => {
      u = String(u); window.__urls.push(u);
      const q = decodeURIComponent(u.split('q=')[1]);
      if (u.includes('googleapis')) {
        if (googleFails) return { ok: false, status: 429 };
        return { ok: true, json: async () => [[['G(' + q + ')']]] };
      }
      return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: 'M(' + q + ')' } }) };
    };
  };
}

// touch=true でタッチ画面のある端末をまねる
async function open(browser, { ua, touch = false, ...opts } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, userAgent: ua, hasTouch: touch });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install();
  await page.addInitScript(fakes(), opts);
  await page.route('**/fonts.googleapis.com/**', r => r.abort());
  await page.route('**/fonts.gstatic.com/**', r => r.abort());
  await page.goto(PAGE);
  const api = {
    page, errors,
    tick: ms => page.clock.runFor(ms),
    // 今動いている認識に結果を届ける。[文字, 確定か] の配列
    // 今動いている認識に結果を届ける。本物と同じく、確定した文は同じ回の中で積み上がっていく
    say: items => page.evaluate(items => {
      const r = window.__live().at(-1);
      r.__finals = r.__finals || [];
      const mk = ([t, f]) => Object.assign([{ transcript: t, confidence: f ? 0.9 : 0 }], { isFinal: f });
      const first = r.__finals.length;
      const results = r.__finals.concat(items.map(mk));
      r.__finals = results.filter(x => x.isFinal);
      r.onresult({ resultIndex: first, results });
      // 本物と同じく、連続モードでないときは文が確定したらその回の認識が終わる
      if (r.continuous === false && items.some(x => x[1])) setTimeout(() => { if (r.state === 'live') { r.state = 'dead'; r.onend && r.onend(); } }, 10);
    }, items),
    // 端末の癖をまねるため、結果の並びと番号をそのまま指定して届ける。[文字, 確定か, 確信度]
    raw: (items, resultIndex = 0) => page.evaluate(({ items, resultIndex }) => {
      const r = window.__live().at(-1);
      r.onresult({ resultIndex, results: items.map(([t, f, c]) => Object.assign([{ transcript: t, confidence: c ?? (f ? 0.9 : 0) }], { isFinal: f })) });
    }, { items, resultIndex }),
    endByItself: () => page.evaluate(() => { const r = window.__live().at(-1); r.state = 'dead'; r.onend(); }),
    error: code => page.evaluate(code => { const r = window.__live().at(-1); r.onerror({ error: code }); }, code),
    liveCount: () => page.evaluate(() => window.__live().length),
    recCount: () => page.evaluate(() => window.__recs.length),
    twoLive: () => page.evaluate(() => !!window.__twoLive),
    lines: () => page.$$eval('#log > .seg', ns => ns.map(n => ({ en: n.querySelector('.en').textContent, ja: n.querySelector('.ja').textContent }))),
    status: () => page.textContent('#status'),
    start: async () => { await page.click('#toggle'); await page.clock.runFor(100); },
  };
  return api;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('開いた直後：版の番号が見え、診断の欄は閉じている', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  assert.match(await t.page.textContent('#diag'), /^v\d+\.\d+\.\d+$/);
  assert.ok(await t.page.isVisible('#diag'), '版の番号が画面に出ている');
  assert.strictEqual(await t.page.isVisible('#report'), false, '診断の欄は閉じている');
  await t.page.click('#diagBtn');
  assert.ok(await t.page.isVisible('#report'));
  assert.match(await t.page.inputValue('#reportText'), /診断 v/);
  await t.page.click('#closeReport');
  assert.strictEqual(await t.page.isVisible('#report'), false);
  return t;
});

test('停止したあとも版の番号が残る', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start(); await t.tick(2100);
  await t.page.click('#toggle');
  assert.match(await t.page.textContent('#diag'), /^v\d+\.\d+\.\d+$/);
  return t;
});

test('確定した文が翻訳されて履歴に残る', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  await t.say([['今日の会議を始めます', true]]);
  await t.tick(50);
  assert.deepStrictEqual(await t.lines(), [{ en: 'G(今日の会議を始めます)', ja: '今日の会議を始めます' }]);
  return t;
});

test('話している途中は仮の訳が出て、無音で1文として確定する', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  await t.say([['次は夜勤の', false]]);
  await t.tick(1600);
  assert.strictEqual(await t.page.textContent('#liveEn'), 'G(次は夜勤の)');
  await t.tick(1000);
  assert.strictEqual((await t.lines()).length, 1);
  assert.strictEqual(await t.liveCount(), 1, '確定のあと認識が1つだけ動いている');
  return t;
});

test('認識が勝手に終わっても自動で再開する（iPad）', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  for (let i = 0; i < 5; i++) { await t.endByItself(); await t.tick(3000); }
  assert.strictEqual(await t.liveCount(), 1);
  assert.match(await t.status(), /翻訳中/);
  return t;
});

test('動いているのに何も届かない状態が続くと作り直す', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  const before = await t.recCount();
  await t.tick(25000);
  assert.ok((await t.recCount()) > before, '作り直された');
  assert.strictEqual(await t.liveCount(), 1);
  return t;
});

test('Android：話しているのに何も返さず固まったら、8秒以内に作り直す', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  const before = await t.recCount();
  await t.tick(8000);
  assert.ok((await t.recCount()) > before, '作り直された');
  assert.strictEqual(await t.liveCount(), 1);
  return t;
});

test('仮の訳は、話し声が途切れたら残らない', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  await t.say([['結論から言うと', false]]);
  await t.tick(1600);
  assert.ok((await t.page.textContent('#liveEn')).length > 0);
  await t.say([]);   // 仮の結果が空で届く
  assert.strictEqual(await t.page.textContent('#liveEn'), '');
  return t;
});

test('起動したのに開始の合図が来ないときも作り直す', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  // 次に作る認識は onstart を返さない（固まる）ようにする
  await t.page.evaluate(() => { const r = window.__live().at(-1); r.state = 'dead'; window.__hang = true; r.onend(); });
  await t.page.evaluate(() => {
    const Orig = window.SpeechRecognition;
    window.SpeechRecognition = window.webkitSpeechRecognition = class extends Orig {
      start() { if (window.__hang) { window.__hang = false; this.state = 'live'; return; } super.start(); }
    };
  });
  await t.tick(12000);
  assert.strictEqual(await t.liveCount(), 1);
  assert.match(await t.status(), /翻訳中/);
  return t;
});

test('認識が2つ同時に動くことがない（再開と見張りが重なっても）', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  // 認識が終わる瞬間を少しずつずらして、見張り役（2秒ごと）と再開の待ち時間が重なる場面を作る
  for (let i = 0; i < 12; i++) {
    await t.tick(4100 + i * 170);
    await t.endByItself();
    await t.tick(400);
  }
  await t.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await t.tick(500);
  assert.strictEqual(await t.twoLive(), false);
  assert.ok((await t.liveCount()) <= 1);
  return t;
});

test('Android も連続モードで動き、同じ文の重複を1回にまとめる', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  assert.strictEqual(await t.page.evaluate(() => window.__live().at(-1).continuous), true);
  await t.say([['会議を始めます', true]]); await t.endByItself(); await t.tick(200);
  await t.say([['会議を始めます', true]]); await t.endByItself(); await t.tick(200);
  await t.error('no-speech'); await t.endByItself(); await t.tick(200);
  await t.say([['次は申し送りです', true]]); await t.endByItself(); await t.tick(200);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['会議を始めます', '次は申し送りです']);
  assert.strictEqual(await t.liveCount(), 1);
  return t;
});

test('Android：1つの認識で3つの文が確定しても、作り直さない（開始音を減らす）', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  const before = await t.recCount();
  await t.say([['会議を始めます', true]]); await t.tick(1000);
  await t.say([['次は夜勤の', false]]); await t.tick(1000);
  await t.say([['次は夜勤の申し送りです', true]]); await t.tick(1000);
  await t.say([['以上です', true]]); await t.tick(1000);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['会議を始めます', '次は夜勤の申し送りです', '以上です']);
  assert.strictEqual(await t.recCount(), before, '文の区切りで作り直していない');
  assert.strictEqual(await t.liveCount(), 1);
  return t;
});

test('Android：無音で先に確定しても作り直さず、あとから届いた確定は続きの言葉だけを出す', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  const before = await t.recCount();
  await t.say([['次は夜勤の', false]]);
  await t.tick(3200);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['次は夜勤の']);
  assert.strictEqual(await t.recCount(), before, '無音の区切りで作り直していない');
  assert.strictEqual(await t.liveCount(), 1);
  await t.raw([['次は夜勤の申し送りです', true, 0.9]]);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['次は夜勤の', '申し送りです']);
  await t.raw([['次は夜勤の申し送りです', true, 0.9], ['以上です', true, 0.9]]);
  await t.tick(50);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['次は夜勤の', '申し送りです', '以上です']);
  return t;
});

test('iPad：無音で確定したら、これまでどおり認識を作り直す', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  const before = await t.recCount();
  await t.say([['次は夜勤の', false]]);
  await t.tick(2000);
  assert.strictEqual((await t.lines()).length, 1);
  assert.strictEqual(await t.recCount(), before + 1, '作り直した');
  assert.strictEqual(await t.liveCount(), 1);
  return t;
});

test('Android：確定した文が「前の文＋続き」で積み上がって届いても、続きだけを出す', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  await t.raw([['今日の会議を', true, 0.9]]);
  await t.raw([['今日の会議を', true, 0.9], ['今日の会議を始めます', true, 0.9]]);
  await t.tick(50);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['今日の会議を', '始めます']);
  return t;
});

test('静かな間は作り直す間隔を延ばし、聞き取れたら7秒に戻す', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  const n0 = await t.recCount();
  await t.tick(8100);
  assert.strictEqual(await t.recCount(), n0 + 1, '最初は7秒ほどで作り直す');
  await t.tick(18900);   // 開始から約27秒
  assert.strictEqual(await t.recCount(), n0 + 1, '2回目は20秒待つので、まだ作り直さない');
  await t.tick(3000);    // 開始から約30秒
  assert.strictEqual(await t.recCount(), n0 + 2, '20秒待ったあとで作り直す');
  await t.say([['はい', true]]);
  const n1 = await t.recCount();
  await t.tick(6500);
  assert.strictEqual(await t.recCount(), n1, '聞き取れた直後は作り直さない');
  await t.tick(1600);
  assert.strictEqual(await t.recCount(), n1 + 1, '聞き取れたあとは、また7秒ほどで作り直す');
  assert.strictEqual(await t.liveCount(), 1);
  return t;
});

test('「パソコン」と名乗る Android タブレットも Android として扱う', async b => {
  const t = await open(b, { ua: DESKTOP_LINUX_UA, touch: true });
  assert.ok(await t.page.evaluate(() => navigator.maxTouchPoints > 0), 'タッチ画面がある');
  await t.page.click('#diagBtn');
  assert.match(await t.page.inputValue('#reportText'), /方式: Android/);
  const pc = await open(b, { ua: DESKTOP_LINUX_UA });
  assert.strictEqual(await pc.page.evaluate(() => navigator.maxTouchPoints), 0);
  await pc.page.click('#diagBtn');
  assert.match(await pc.page.inputValue('#reportText'), /方式: 標準/, 'タッチ画面のないパソコンは Android ではない');
  assert.deepStrictEqual(pc.errors, []);
  await pc.page.close();
  return t;
});

test('iPhone/iPad：確定済みの文が送り直されても、同じ文を二度出さない', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  await t.raw([['会議を始めます', true]]);
  await t.raw([['会議を始めます', true], ['次は', false]]);          // 番号0のまま全部送り直してくる
  await t.raw([['会議を始めます', true], ['次は夜勤の話です', true]]);
  await t.raw([['会議を始めます', true], ['次は夜勤の話です', true]]);
  await t.tick(50);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['会議を始めます', '次は夜勤の話です']);
  return t;
});

test('Android：確信度0の「確定」は途中経過として扱い、細切れの文を出さない', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  await t.raw([['それでは', true, 0]]);
  await t.raw([['それでは会議を', true, 0]]);
  assert.strictEqual((await t.lines()).length, 0);
  assert.strictEqual(await t.page.textContent('#liveJa'), 'それでは会議を');
  await t.raw([['それでは会議を始めます', true, 0.92]]);
  await t.tick(50);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['それでは会議を始めます']);
  return t;
});

test('Android：確信度0のまま終わっても、その文を取りこぼさない', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  await t.raw([['休憩にしましょう', true, 0]]);
  await t.endByItself(); await t.tick(200);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['休憩にしましょう']);
  return t;
});

test('一瞬で終わる失敗が続くときは、再開の間隔を空ける', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  for (const wait of [100, 600, 1100, 2100, 4100]) { await t.endByItself(); await t.tick(wait); }
  await t.endByItself();
  await t.tick(1000);
  assert.strictEqual(await t.liveCount(), 0, '失敗が続いたあとは、すぐには作り直さない');
  await t.tick(4000);
  assert.strictEqual(await t.liveCount(), 1, '少し待ってから再開する');
  await t.say([['聞こえました', true]]); await t.endByItself(); await t.tick(200);
  assert.strictEqual(await t.liveCount(), 1, '聞き取れたら、またすぐ再開する動きに戻る');
  return t;
});

test('動いていたのに途中で断られたら、止めずに「タップで再開」にする', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  await t.say([['会議を始めます', true]]);
  await t.error('not-allowed');
  await t.tick(8000);
  assert.match(await t.status(), /タップで再開/);
  assert.strictEqual(await t.liveCount(), 0, '勝手には作り直さない');
  await t.page.click('#log');
  await t.tick(200);
  assert.strictEqual(await t.liveCount(), 1);
  assert.match(await t.status(), /翻訳中/);
  assert.strictEqual((await t.lines()).length, 1, '履歴は残っている');
  return t;
});

test('Google翻訳が使えないときは予備の翻訳に切り替える', async b => {
  const t = await open(b, { ua: IPAD_UA, googleFails: true });
  await t.start();
  await t.say([['休憩にします', true]]);
  await t.tick(50);
  assert.strictEqual((await t.lines())[0].en, 'M(休憩にします)');
  return t;
});

test('マイクが許可されないときは止まって説明を出す', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.page.evaluate(() => { window.__deny = true; });
  await t.start();
  await t.tick(3000);
  assert.match(await t.status(), /マイク不可/);
  assert.strictEqual(await t.liveCount(), 0);
  return t;
});

test('音声認識がないブラウザでは案内を出す', async b => {
  const t = await open(b, { ua: ANDROID_UA, noSR: true });
  await t.start();
  assert.match(await t.page.textContent('#msg'), /Google Chrome/);
  return t;
});

test('診断情報に版と記録が入り、会議の中身は入らない', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  await t.say([['秘密の議題です', true]]);
  await t.endByItself(); await t.tick(3000);
  await t.page.click('#diagBtn');
  const rep = await t.page.inputValue('#reportText');
  assert.match(rep, /診断 v\d+\.\d+\.\d+/);
  assert.match(rep, /onend/);
  assert.ok(!rep.includes('秘密の議題'), '会議の中身が入っていない');
  return t;
});

test('停止を押すと認識が止まり、再開しない', async b => {
  const t = await open(b, { ua: IPAD_UA });
  await t.start();
  await t.page.click('#toggle');
  await t.tick(10000);
  assert.strictEqual(await t.liveCount(), 0);
  assert.match(await t.status(), /停止中/);
  return t;
});

(async () => {
  // GitHub上では、最初から入っている Chrome を使う（テスト用ブラウザのダウンロードが止まることがあったため）
  const browser = await chromium.launch(process.env.CI ? { channel: 'chrome' } : {});
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      const t = await fn(browser);
      if (t.errors.length) throw new Error('ページのエラー: ' + t.errors.join(' / '));
      await t.page.close();
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.log('  NG   ' + name + '\n       ' + (e.message || e).split('\n').join('\n       '));
    }
  }
  await browser.close();
  console.log(failed ? `\n${failed} 件失敗 / ${tests.length} 件` : `\nすべて成功 (${tests.length} 件)`);
  process.exit(failed ? 1 : 0);
})();
