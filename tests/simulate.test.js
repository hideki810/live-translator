// 本物のマイクの代わりに「にせの音声認識」を使って、アプリの動きを自動で確かめるテスト。
// 実行: npm test   （Playwright と Chromium が必要）
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
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

async function open(browser, { ua, ...opts } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, userAgent: ua });
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
    say: items => page.evaluate(items => {
      const r = window.__live().at(-1);
      r.onresult({ resultIndex: 0, results: items.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });
    }, items),
    endByItself: () => page.evaluate(() => { const r = window.__live().at(-1); r.state = 'dead'; r.onend(); }),
    error: code => page.evaluate(code => { const r = window.__live().at(-1); r.onerror({ error: code }); }, code),
    liveCount: () => page.evaluate(() => window.__live().length),
    recCount: () => page.evaluate(() => window.__recs.length),
    twoLive: () => page.evaluate(() => !!window.__twoLive),
    lines: () => page.$$eval('.seg', ns => ns.map(n => ({ en: n.querySelector('.en').textContent, ja: n.querySelector('.ja').textContent }))),
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

test('Android は1文ごとの方式で動き、同じ文の重複を1回にまとめる', async b => {
  const t = await open(b, { ua: ANDROID_UA });
  await t.start();
  assert.strictEqual(await t.page.evaluate(() => window.__live().at(-1).continuous), false);
  await t.say([['会議を始めます', true]]); await t.endByItself(); await t.tick(200);
  await t.say([['会議を始めます', true]]); await t.endByItself(); await t.tick(200);
  await t.error('no-speech'); await t.endByItself(); await t.tick(200);
  await t.say([['次は申し送りです', true]]); await t.endByItself(); await t.tick(200);
  assert.deepStrictEqual((await t.lines()).map(l => l.ja), ['会議を始めます', '次は申し送りです']);
  assert.strictEqual(await t.liveCount(), 1);
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
  await t.start();
  await t.error('not-allowed');
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
  const browser = await chromium.launch();
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
