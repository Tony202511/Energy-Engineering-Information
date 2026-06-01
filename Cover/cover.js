const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ── 날짜 포맷 ──────────────────────────────────────
const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
const day = now.getDate();
const days = ['일','월','화','수','목','금','토'];
const dow = days[now.getDay()];
const dateStr = `${year}년 ${month}월 ${day}일 (${dow})`;

// ── HTML 읽기 & 날짜 교체 ──────────────────────────
const htmlPath = path.resolve(__dirname, 'origin', 'cover_20260429.html');
let html = fs.readFileSync(htmlPath, 'utf-8');
html = html.replace(
  /<span class="meta-value date">.*?<\/span>/,
  `<span class="meta-value date">${dateStr}</span>`
);

// ── 임시 파일 저장 ─────────────────────────────────
const tmpPath = path.resolve(__dirname, '_cover_tmp.html');
fs.writeFileSync(tmpPath, html, 'utf-8');

// ── Puppeteer로 PNG 출력 ───────────────────────────
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.setViewport({ width: 1100, height: 620, deviceScaleFactor: 1 }); // x2 고해상도

  await page.goto('file:///' + tmpPath.replace(/\\/g, '/'), {
    waitUntil: 'networkidle0'
  });

  const outName = `cover_${year}${String(month).padStart(2,'0')}${String(day).padStart(2,'0')}.png`;
  const outPath = path.resolve(__dirname, outName);

  await page.screenshot({
    path: outPath,
    clip: { x: 0, y: 0, width: 1100, height: 620 }
  });

  await browser.close();
  fs.unlinkSync(tmpPath); // 임시파일 삭제

  console.log(`✅ 저장 완료: ${outPath}`);
})();