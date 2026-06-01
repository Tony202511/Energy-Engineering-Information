/**
 * generate_newsletter.js  (v7)
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const YYYYMMDD     = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
const DISPLAY_DATE = `${today.getFullYear()}년 ${today.getMonth()+1}월 ${today.getDate()}일`;
const WEEKDAY      = ['일','월','화','수','목','금','토'][today.getDay()];
const OUTPUT_FILE  = path.join(__dirname, `index_${YYYYMMDD}.html`);

// 법령·행정규칙 소관부처 필터 목록 (수정 시 여기만 변경)
const INCLUDE_MINISTRY = [
  '국토교통', '기획재정', '농림축산식품부', '산림', '산업통상', '소방', '해양수산부',
  '행정안전', '환경', '고용노동', '과학기술정보통신', '국가유산', '국방부', '안전보건공단', '기후에너지환경', '원자력'
];

// 기후에너지환경부 부서명 필터 키워드 (수정 시 여기만 변경)
const MCEE_DEPT_KEYWORDS = ['전력시장', '열산업', '분산', '폐자원', '폐기물'];

// 날짜 문자열에서 YYYY-MM-DD 추출
function parseDate(text) {
  if (!text) return '';
  const m = text.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : '';
}

// 최신 날짜 순 정렬
function sortByDate(items) {
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// 날짜 누락 항목 보완: 상세 페이지 방문
async function enrichDates(page, items) {
  const missing = items.filter(i => !i.date && i.href);
  if (missing.length === 0) return items;
  console.log(`     -> 날짜 누락 ${missing.length}건, 상세 페이지 보완 중...`);
  for (const item of missing) {
    try {
      await page.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
      item.date = parseDate(text);
    } catch { item.date = ''; }
  }
  return items;
}

// ── 전기위원회 ───────────────────────────────────────────────
async function scrapeKorec(page) {
  console.log('  -> 전기위원회 수집 중...');
  try {

    await page.goto('https://korec.go.kr/notice/selectNoticeList.do', {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await page.waitForTimeout(1500);
    let items = await page.evaluate(() => {
      function extractDate(row) {
        for (const el of [...row.querySelectorAll('td, span')].reverse()) {
          const t = el.innerText?.trim() || '';
          const m = t.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
          if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
        }
        return '';
      }
      const results = [];
      for (const row of document.querySelectorAll('tbody tr')) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 2) continue;

        let titleText = '', href = '';
        for (let i = 1; i < tds.length; i++) {
          const a = tds[i].querySelector('a');
          const text = tds[i].innerText?.trim();
          if (text && text.length > 3 && isNaN(text) && !text.includes('첨부')) {
            titleText = text;
            if (a) {
              const src = a.getAttribute('onclick') || a.getAttribute('href') || '';
              const m = src.match(/['"_]?(\d{3,})['"_]?/);
              href = m ? `https://korec.go.kr/notice/selectNoticeView.do?bbs_sntnc_no=${m[1]}`
                       : (!a.href?.startsWith('javascript') ? a.href : '');
            }
            break;
          }
        }
        if (!titleText) continue;
        results.push({ title: titleText, href, date: extractDate(row) });
      }
      return results;
    });
    items = sortByDate(await enrichDates(page, items))
    console.log(`     ✅ ${items.length}건 수집 (날짜: ${items.filter(i=>i.date).length}건)`);
    return { ok: true, items };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 한국에너지공단 ───────────────────────────────────────────
async function scrapeEnergy(page) {
  console.log('  -> 한국에너지공단 수집 중...');
  try {

    // networkidle: JS 렌더링 완료까지 대기
    await page.goto('https://www.energy.or.kr/front/board/List2.do', {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForTimeout(1500);
    const items = await page.evaluate(() => {
      function extractDate(row) {
        for (const el of [...row.querySelectorAll('td, span')].reverse()) {
          const t = el.innerText?.trim() || '';
          const m = t.match(/(\d{4})[.\-\/년\-]\s*(\d{1,2})[.\-\/월\-]\s*(\d{1,2})/);
          if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
        }
        return '';
      }
      const BASE = 'https://www.energy.or.kr';
      const results = [];
      for (const row of document.querySelectorAll('table tbody tr')) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 2) continue;
        let titleText = '', href = '';
        for (let i = 0; i < tds.length; i++) {
          const a    = tds[i].querySelector('a');
          const text = tds[i].innerText?.trim();
          if (!text || text.length <= 3 || !isNaN(text)) continue;
          // 제목 td: 링크가 있거나 텍스트가 가장 긴 td
          if (a) {
            titleText = text;
            // onclick="fn_view('1234')" 패턴에서 ID 추출
            const oc = a.getAttribute('onclick') || '';
            const m2 = oc.match(/fn_view\(['"]*(\d+)['"]*\)/);
            if (m2) {
              href = `${BASE}/front/board/View2.do?brd_sn=${m2[1]}`;
            } else if (a.href && !a.href.startsWith('javascript')) {
              href = a.href;
            } else {
              href = `${BASE}/front/board/List2.do`;
            }
            break;
          }
        }
        if (!titleText) continue;
        results.push({ title: titleText, href, date: extractDate(row) });
      }
      return results;
    });
    const sorted = sortByDate(items);
    console.log(`     ✅ ${sorted.length}건 수집 (날짜: ${sorted.filter(i=>i.date).length}건)`);
    return { ok: true, items: sorted };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 한국에너지공단 신재생에너지센터 ──────────────────────────
async function scrapeKnrec(page) {
  console.log('  -> 신재생에너지센터 수집 중...');
  try {

    await page.goto('https://www.knrec.or.kr/biz/pds/notice/list.do', {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await page.waitForTimeout(1500);
    let items = await page.evaluate(() => {
      function extractDate(row) {
        for (const el of [...row.querySelectorAll('td, span, div')].reverse()) {
          const t = el.innerText?.trim() || '';
          const m = t.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
          if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
        }
        return '';
      }
      const results = [];
      for (const row of document.querySelectorAll('table tbody tr')) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 2) continue;

        let titleText = '', href = '';
        // 모든 td 중 링크가 있고 텍스트가 가장 긴 td를 제목으로 선택
        let best = { len: 0, text: '', href: '' };
        for (let i = 0; i < tds.length; i++) {
          const a = tds[i].querySelector('a');
          const text = tds[i].innerText?.trim();
          if (a && text && text.length > best.len && isNaN(text)) {
            best = { len: text.length, text, href: a.href || '' };
          }
        }
        titleText = best.text;
        href = best.href || 'https://www.knrec.or.kr/biz/pds/notice/list.do';
        if (href.startsWith('javascript')) href = 'https://www.knrec.or.kr/biz/pds/notice/list.do';
        if (!titleText) continue;
        results.push({ title: titleText, href, date: extractDate(row) });

      }
      return results;
    });

    // 제목이 여전히 짧으면([안내] 등) 상세 페이지에서 보완
    for (const item of items) {
      if (item.title.length < 6 && item.href && !item.href.includes('list.do')) {
        try {
          await page.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
          const detail = await page.evaluate(() => {
            const h = document.querySelector('h3, h2, .view_title, .board_view_tit, td.title');
            return h?.innerText?.trim() || '';
          });
          if (detail) item.title = detail;
          if (!item.date) {
            const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
            item.date = parseDate(text);
          }
        } catch {}
      }
    }
    items = sortByDate(items)

    console.log(`     ✅ ${items.length}건 수집 (날짜: ${items.filter(i=>i.date).length}건)`);
    return { ok: true, items };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 한국풍력산업협회 ─────────────────────────────────────────
// #bo_list 안에 <tr> 없음 확인됨. a[href*="wr_id"]로 직접 수집.
// 날짜는 부모/형제 요소 텍스트에서 추출, 실패 시 상세 페이지 방문.
async function scrapeKweia(page) {
  console.log('  -> 한국풍력산업협회 수집 중...');
  try {

    // networkidle 대신 domcontentloaded 사용:
    // 해당 사이트는 지속 연결로 networkidle에 도달하지 못해 타임아웃 발생
    await page.goto('https://www.kweia.or.kr/bbs/board.php?bo_table=notice', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    // 게시글 링크가 DOM에 나타날 때까지 최대 10초 대기
    await page.waitForSelector('a[href*="wr_id"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    let items = await page.evaluate(() => {
      function extractDate(el) {
        if (!el) return '';
        const t = el.innerText || '';
        const m = t.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
        return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : '';
      }
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="wr_id"]'));
      for (const a of links) {
        const title = a.innerText?.trim();
        if (!title || title.length < 3) continue;
        // 가장 가까운 블록 부모에서 날짜 탐색
        const parent = a.closest('div, li, article, section') || a.parentElement;
        // 형제 요소 순회
        let date = '';
        if (parent) {
          for (const sib of Array.from(parent.children)) {
            date = extractDate(sib);
            if (date) break;
          }
          // 형제에서 못 찾으면 부모 전체 텍스트
          if (!date) date = extractDate(parent);
        }
        results.push({ title, href: a.href || '', date });
      }
      return results;
    });
    items = sortByDate(await enrichDates(page, items));
    console.log(`     ✅ ${items.length}건 수집 (날짜: ${items.filter(i=>i.date).length}건)`);
    return { ok: true, items };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}


// ── 국가건설기준센터 (KCSC) ──────────────────────────────────
async function scrapeKcsc() {
  console.log('  -> 국가건설기준센터 수집 중...');
  try {
    const res = await fetch('https://kcsc.re.kr/api/main/document-info-recent', {
      headers: {
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer':         'https://www.kcsc.re.kr/',
        'Origin':          'https://www.kcsc.re.kr',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json  = await res.json();
    const board = json?.result?.boardList ?? [];
    if (board.length === 0) throw new Error('데이터 없음');

    const items = board.map(item => {
      // rvsnYmd: "20240315" → "2024-03-15"
      const raw  = String(item.rvsnYmd || '');
      const date = raw.length === 8
        ? `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`
        : raw;
      const title = item.docNm || '-';
      const href  = `https://www.kcsc.re.kr/standardCode/viewer/${encodeURIComponent(item.kcscCd)}:${item.rvsnYmd}`;
      return { title, href, date, code: item.kcscCd || '', docEr: item.docEr || '' };
    });

    const sorted = sortByDate(items);
    console.log(`     ✅ ${sorted.length}건 수집 (날짜: ${sorted.filter(i=>i.date).length}건)`);
    return { ok: true, items: sorted };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 국가법령정보센터 (최신 제·개정 법령) ─────────────────────
async function scrapeLaw(page) {
  console.log('  -> 국가법령정보센터 수집 중...');
  try {

    await page.goto(
      'https://www.law.go.kr/LSW/lsSc.do?menuId=1&subMenuId=23&tabMenuId=123&eventGubun=060103&query=',
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await page.waitForTimeout(2000);

    let items = await page.evaluate((INCLUDE_MINISTRY) => {
      const isIncluded = (text) => INCLUDE_MINISTRY.some(m => text.includes(m));
      const results = [];
      const rows = document.querySelectorAll('table tbody tr');
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 4) continue;

        let title = '', href = '', date = '', lawType = '', ministry = '';

        for (let i = 0; i < tds.length; i++) {
          const td   = tds[i];
          const a    = td.querySelector('a');
          // 법령명: 링크의 innerText만 사용 (td.innerText는 날짜 등 포함될 수 있음)
          if (a && !title) {
            const t = a.innerText?.trim() || '';
            if (t.length > 2) { title = t; href = a.href || ''; continue; }
          }
          const text = td.innerText?.trim() || '';
          if (!text) continue;
          // 번호 스킵
          if (/^\d+$/.test(text)) continue;
          // 이미 제목 링크로 처리된 td 스킵
          if (a && title && td.querySelector('a')?.innerText?.trim() === title) continue;
          // 공포일자
          if (!date) {
            const m = text.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
            if (m) { date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; continue; }
          }
          // 법령유형 (제정/개정 키워드)
          if (!lawType && /제정|개정|폐지|타법|제명/.test(text) && text.length <= 10) {
            lawType = text; continue;
          }
          // 소관부처 (한글, 2~15자, 숫자 아님)
          if (!ministry && isNaN(text) && text.length >= 2 && text.length <= 15
              && !/\d{4}/.test(text) && !/제정|개정|폐지/.test(text)) {
            ministry = text;
          }
        }

        if (!title) continue;
        const rowText = row.innerText || '';
        if (!isIncluded(rowText)) continue;
        results.push({ title, href, date, lawType, ministry });
      }
      return results;
    }, INCLUDE_MINISTRY);

    // 날짜 누락 보완
    items = await enrichDates(page, items);
    items = sortByDate(items);

    console.log(`     ✅ ${items.length}건 수집 (날짜: ${items.filter(i=>i.date).length}건)`);
    return { ok: true, items };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 국가법령정보센터 (최신 제·개정 행정규칙) ──────────────────
async function scrapeAdminRule(page) {
  console.log('  -> 행정규칙(훈령·예규·고시) 수집 중...');
  try {

    await page.goto(
      'https://www.law.go.kr/admRulSc.do?menuId=5&subMenuId=45&tabMenuId=203&query=',
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await page.waitForTimeout(2000);

    let items = await page.evaluate((INCLUDE_MINISTRY) => {
      const isIncluded = (text) => INCLUDE_MINISTRY.some(m => text.includes(m));

      const results = [];
      const rows = document.querySelectorAll('table tbody tr');
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 4) continue;

        let title = '', href = '', date = '', lawType = '', ministry = '';

        for (let i = 0; i < tds.length; i++) {
          const td = tds[i];
          const a  = td.querySelector('a');
          if (a && !title) {
            const t = a.innerText?.trim() || '';
            if (t.length > 2) { title = t; href = a.href || ''; continue; }
          }
          const text = td.innerText?.trim() || '';
          if (!text) continue;
          if (/^\d+$/.test(text)) continue;
          if (a && title && td.querySelector('a')?.innerText?.trim() === title) continue;
          if (!date) {
            const m = text.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
            if (m) { date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; continue; }
          }
          if (!lawType && /제정|개정|폐지|타법|제명/.test(text) && text.length <= 10) {
            lawType = text; continue;
          }
          if (!ministry && isNaN(text) && text.length >= 2 && text.length <= 15
              && !/\d{4}/.test(text) && !/제정|개정|폐지/.test(text)) {
            ministry = text;
          }
        }

        if (!title) continue;
        const rowText = row.innerText || '';
        if (!isIncluded(rowText)) continue;
        results.push({ title, href, date, lawType, ministry });
      }
      return results;
    }, INCLUDE_MINISTRY);

    items = await enrichDates(page, items);
    items = sortByDate(items);

    console.log(`     ✅ ${items.length}건 수집 (날짜: ${items.filter(i=>i.date).length}건)`);
    return { ok: true, items };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 나라장터(공사원가통합관리시스템) 공지사항 ──────────────────
async function scrapeG2b(page) {
  console.log('  -> 나라장터 공지사항 수집 중...');
  try {

    await page.goto(
      'https://npccs.g2b.go.kr:8785/portal/main/main/portalMainForm.do',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForTimeout(3000);

    const items = await page.evaluate(() => {
      const BASE = 'https://npccs.g2b.go.kr:8785';
      const LIST_URL = BASE + '/portal/bbs/ntcmtr/bbsForm.do';
      const results = [];

      // 공지사항 영역: p.noti_title = '공지사항' 인 notice_area
      const areas = document.querySelectorAll('div.notice_area');
      let noticeUl = null;
      for (const area of areas) {
        const title = area.querySelector('p.noti_title');
        if (title?.innerText?.trim() === '공지사항') {
          noticeUl = area.querySelector('ul[data-ename="el_bbsNotiList"]');
          break;
        }
      }
      if (!noticeUl) return results;

      for (const li of noticeUl.querySelectorAll('li.post_item')) {
        const date  = li.querySelector('span.txt_date')?.innerText?.trim() || '';
        const title = li.querySelector('span.txt_title')?.innerText?.trim() || '';
        if (!title) continue;
        results.push({ title, href: LIST_URL, date });
      }
      return results;
    });

    const sorted = sortByDate(items);
    console.log(`     ✅ ${sorted.length}건 수집 (날짜: ${sorted.filter(i=>i.date).length}건)`);
    return { ok: true, items: sorted };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}



// ── KICT 공사비원가관리센터 공지사항 ──────────────────────────
async function scrapeKict(page) {
  console.log('  -> KICT 공사비원가관리센터 수집 중...');
  try {

    await page.goto('https://cost.kict.re.kr/#/notice/application',
      { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    const items = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('table tbody tr');
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 3) continue;
        // 제목 링크 탐색
        let title = '', href = '';
        for (const td of tds) {
          const a = td.querySelector('a');
          const t = (a || td).innerText?.trim();
          if (t && t.length > 2 && isNaN(t) && !/^\d{4}-/.test(t)) {
            title = t;
            href  = a?.href || '';
            break;
          }
        }
        if (!title) continue;
        // 날짜
        let date = '';
        for (const td of tds) {
          const t = td.innerText?.trim() || '';
          const m = t.match(/(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
          if (m) { date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; break; }
        }
        results.push({ title, href, date });
      }
      return results;
    });

    const sorted = sortByDate(items);
    console.log(`     ✅ ${sorted.length}건 수집 (날짜: ${sorted.filter(i=>i.date).length}건)`);
    return { ok: true, items: sorted };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 기후에너지환경부 공지사항 ─────────────────────────────────
// pagerOffset 파라미터로 직접 페이지 순회 (클릭 방식 미동작 확인됨)
async function scrapeMcee(page) {
  console.log('  -> 기후에너지환경부 수집 중...');
  try {

    const BASE     = 'https://www.mcee.go.kr';
    const LIST_URL = `${BASE}/home/web/board/list.do?maxPageItems=10&maxIndexPages=10&boardMasterId=939&menuId=10598&pagerOffset=`;
    const collected  = [];
    const seenTitles = new Set();
    const MAX_PAGES  = 20;

    for (let pageIdx = 0; pageIdx < MAX_PAGES && collected.length < 10; pageIdx++) {
      await page.goto(LIST_URL + (pageIdx * 10), {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await page.waitForTimeout(1500);

      const pageItems = await page.evaluate(({ BASE, KEYWORDS }) => {
        const isMatch = t => KEYWORDS.some(k => t.includes(k));
        const results = [];
        for (const row of document.querySelectorAll('table tbody tr')) {
          const tds = row.querySelectorAll('td');
          if (tds.length < 3) continue;
          let title = '', href = '', date = '', dept = '', titleIdx = -1, bestLen = 0;
          for (let i = 0; i < tds.length; i++) {
            const a = tds[i].querySelector('a');
            const t = a?.innerText?.trim() || tds[i].innerText?.trim() || '';
            if (a && t.length > bestLen && isNaN(t)) {
              bestLen = t.length; title = t; titleIdx = i;
              const rawHref = a.getAttribute('href') || '';
              href = rawHref.startsWith('http') ? rawHref
                   : rawHref ? BASE + rawHref.replace(/;jsessionid=[^?]*/, '') : '';
            }
          }
          if (!title) continue;
          for (let i = 0; i < tds.length; i++) {
            if (i === titleIdx) continue;
            const text = tds[i].innerText?.trim() || '';
            if (!text || /^\d+$/.test(text)) continue;
            if (!date) {
              const m = text.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
              if (m) { date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; continue; }
            }
            if (!dept && !tds[i].querySelector('a') && text.length <= 30 && !/\d{4}/.test(text)) dept = text;
          }
          results.push({ title, href, date, dept });
        }
        return results;
      }, { BASE, KEYWORDS: MCEE_DEPT_KEYWORDS });

      if (pageItems.length === 0) break;
      for (const item of pageItems) {
        if (seenTitles.has(item.title)) continue;
        seenTitles.add(item.title);
        if (MCEE_DEPT_KEYWORDS.some(k => item.dept.includes(k))) {
          collected.push({ ...item, lawType: item.dept });
        }
      }
    }

    const items = sortByDate(collected).slice(0, 10);
    console.log(`     ✅ ${items.length}건 수집 (날짜: ${items.filter(i=>i.date).length}건)`);
    return { ok: true, items };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── 한국환경공단 공지사항 ────────────────────────────────────
// 첫 페이지만 수집. 핀 공지와 일반 목록이 중복되므로 제목 기준 중복 제거.
// href: javascript:; → onclick의 article_seq 값으로 상세 URL 구성
async function scrapeKeco(page) {
  console.log('  -> 한국환경공단 수집 중...');
  try {

    const BASE     = 'https://www.keco.or.kr';
    const LIST_URL = `${BASE}/web/lay1/bbs/S1T10C108/A/18/list.do`;
    const VIEW_URL = `${BASE}/web/lay1/bbs/S1T10C108/A/18/view.do?article_seq=`;

    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const items = await page.evaluate(({ BASE, LIST_URL, VIEW_URL }) => {
      const results = [];
      const seen    = new Set(); // 핀 공지 중복 제거용

      for (const row of document.querySelectorAll('table tbody tr')) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 3) continue;

        let title = '', href = LIST_URL, date = '', titleIdx = -1, bestLen = 0;

        // 제목 td 식별 (링크 있고 텍스트가 가장 긴 것)
        for (let i = 0; i < tds.length; i++) {
          const a = tds[i].querySelector('a');
          const t = a?.innerText?.trim() || tds[i].innerText?.trim() || '';
          if (a && t.length > bestLen && isNaN(t)) {
            bestLen = t.length; title = t; titleIdx = i;
            const rawHref = a.getAttribute('href') || '';
            if (rawHref && !rawHref.includes('javascript')) {
              href = rawHref.startsWith('http') ? rawHref : BASE + rawHref;
            } else {
              // onclick: location.href='./view.do?article_seq=99526&...'
              const oc = a.getAttribute('onclick') || '';
              const m  = oc.match(/article_seq=(\d+)/);
              href = m ? VIEW_URL + m[1] : LIST_URL;
            }
          }
        }
        if (!title || seen.has(title)) continue;
        seen.add(title);

        // 날짜 추출
        for (let i = 0; i < tds.length; i++) {
          if (i === titleIdx) continue;
          const text = tds[i].innerText?.trim() || '';
          const m = text.match(/(\d{4})[.\-\/년]\s*(\d{1,2})[.\-\/월]\s*(\d{1,2})/);
          if (m) { date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; break; }
        }

        results.push({ title, href, date });
      }
      return results;
    }, { BASE, LIST_URL, VIEW_URL });

    const sorted = sortByDate(items);
    console.log(`     ✅ ${sorted.length}건 수집 (날짜: ${sorted.filter(i=>i.date).length}건)`);
    return { ok: true, items: sorted };
  } catch (e) {
    console.warn(`     ⚠  수집 실패: ${e.message.split('\n')[0]}`);
    return { ok: false, items: [] };
  }
}

// ── SMP 차트 캡처 ────────────────────────────────────────────
async function screenshotSmp(page) {
  console.log('  -> SMP 차트 캡처 중...');
  try {

    // networkidle: 차트 데이터 API 호출 완료까지 대기
    await page.goto(
      'https://epsis.kpx.or.kr/epsisnew/selectEkmaSmpSmpChart.do?menuId=040201',
      { waitUntil: 'networkidle', timeout: 30000 }
    );

    // Highcharts 시리즈 path가 실제로 그려질 때까지 대기 (최대 15초)
    await page.waitForFunction(() => {
      const paths = document.querySelectorAll('.highcharts-series path, .highcharts-series rect');
      // path의 d 속성에 실제 좌표가 있는지 확인 (데이터 없으면 'M 0 0' 수준으로 짧음)
      return [...paths].some(p => (p.getAttribute('d') || '').length > 50);
    }, { timeout: 15000 }).catch(() => console.log('     ⚠ 차트 렌더링 대기 시간 초과, 진행'));

    await page.waitForTimeout(1000); // 추가 안정화

    // 차트 컨테이너를 직접 element screenshot
    for (const sel of ['.highcharts-container', '#container', 'svg.highcharts-root', 'canvas']) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        const buf = await el.screenshot({ type: 'png' });
        console.log(`     ✅ SMP 차트 캡처 완료 (${sel})`);
        return buf.toString('base64');
      }
    }

    // 폴백: 고정 좌표로 차트 영역만 클리핑
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 80, width: 1280, height: 500 } });
    console.log('     ✅ SMP 스크린샷 (폴백)');
    return buf.toString('base64');
  } catch (e) {
    console.warn(`     ⚠  SMP 캡처 실패: ${e.message.split('\n')[0]}`);
    return null;
  }
}

// ── HTML 생성 ────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
const SITE_META = {
  korec:  { name: '전기위원회',             emoji: '🏛️', color: '#1a3d7c', siteUrl: 'https://www.korec.go.kr' },
  energy: { name: '한국에너지공단',         emoji: '🌿', color: '#006b3c', siteUrl: 'https://www.energy.or.kr' },
  knrec:  { name: '한국에너지공단 신재생에너지센터', emoji: '☀️', color: '#2e7d32', siteUrl: 'https://www.knrec.or.kr/biz/pds/notice/list.do' },
  kweia:  { name: '한국풍력산업협회',       emoji: '💨', color: '#0072b8', siteUrl: 'https://www.kweia.or.kr'  },
  kcsc:   { name: '최신 설계기준', emoji: '🏗️', color: '#5d4037', siteUrl: 'https://www.kcsc.re.kr'   },
  law:       { name: '최신 법령',                       emoji: '📜', color: '#37474f', siteUrl: 'https://www.law.go.kr/LSW/lsSc.do?menuId=1&subMenuId=23&tabMenuId=123&eventGubun=060103&query=' },
  adminRule: { name: '최신 행정규칙(훈령, 예규, 고시)', emoji: '📋', color: '#4a5568', siteUrl: 'https://www.law.go.kr/admRulSc.do?menuId=5&subMenuId=45&tabMenuId=203&query=' },
  kict:      { name: '공사비원가관리센터',             emoji: '🏗️', color: '#1b5e20', siteUrl: 'https://cost.kict.re.kr/#/notice/application' },
  g2b:       { name: '공사원가통합관리시스템',                    emoji: '🏢', color: '#1565c0', siteUrl: 'https://npccs.g2b.go.kr:8785/portal/main/main/portalMainForm.do' },
  mcee:      { name: '기후에너지환경부 보도자료',             emoji: '🌍', color: '#00695c', siteUrl: 'https://www.mcee.go.kr/home/web/index.do?menuId=10598',
               filterNote: MCEE_DEPT_KEYWORDS },
  keco:      { name: '한국환경공단',                  emoji: '♻️', color: '#558b2f', siteUrl: 'https://www.keco.or.kr/web/lay1/bbs/S1T10C108/A/18/list.do' },
};

// 2영업일 이내 여부 판단 (토·일 제외)
function isNew(dateStr) {
  if (!dateStr) return false;
  const post = new Date(dateStr);
  const now  = new Date();
  now.setHours(0, 0, 0, 0);
  let bizDays = 0;
  const cur = new Date(now);
  while (bizDays < 2) {
    cur.setDate(cur.getDate() - 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) bizDays++;
  }
  return post >= cur;
}

function buildHtml(results, smpBase64) {
  function noticeSection(id, result) {
    const m = SITE_META[id];
    const excludeBtn = (id === 'law' || id === 'adminRule')
      ? `<span class="exclude-wrap">
          <span class="exclude-icon">검색 필터</span>
          <span class="exclude-tooltip">표시 필터: ${INCLUDE_MINISTRY.join(', ')}</span>
        </span>`
      : m.filterNote
      ? `<span class="exclude-wrap">
          <span class="exclude-icon">부서 필터</span>
          <span class="exclude-tooltip">표시 부서: ${m.filterNote.join(', ')}</span>
        </span>`
      : '';
    const header = `<div class="section-header" style="background:${m.color}">
        <h2>${m.emoji} ${m.name}</h2>
        <div style="display:flex;align-items:center;gap:8px">
          ${excludeBtn}
          <a href="${m.siteUrl}" class="site-link" target="_blank">사이트 바로가기 →</a>
        </div>
      </div>`;
    if (!result.ok || result.items.length === 0) {
      return `<div class="section">${header}<div class="empty-state">⚠️ 공지를 수집하지 못했습니다.<br/><a href="${m.siteUrl}" target="_blank">사이트에서 직접 확인 →</a></div></div>`;
    }
    const visible = result.items.slice(0, 5);
    const hidden  = result.items.slice(5);
    const makeRow = item => {
      const newBadge = isNew(item.date) ? ' <span class="new-badge">NEW</span>' : '';
      let titleHtml;
      if (item.code) {
        const typeLabel = item.docEr === 'E' ? '제정' : item.docEr === 'R' ? '개정' : '';
        const typeBadge = typeLabel ? `<span class="kcsc-type">${typeLabel}</span>` : '';
        titleHtml = `${typeBadge}<span class="kcsc-code">${escHtml(item.code)}</span><span>${escHtml(item.title)}</span>${newBadge}`;
      } else if (item.lawType) {
        titleHtml = `<span class="law-type">${escHtml(item.lawType)}</span><span>${escHtml(item.title)}</span>${newBadge}`;
      } else {
        titleHtml = `${escHtml(item.title)}${newBadge}`;
      }
      return `
      <div class="notice-item">
        <span class="notice-title">${titleHtml}</span>
        <span class="notice-date">${item.date || '-'}</span>
        <a href="${item.href || m.siteUrl}" class="read-btn" target="_blank">원문보기</a>
      </div>`;
    };
    const visibleRows = visible.map(makeRow).join('');
    const hiddenRows  = hidden.map(makeRow).join('');
    const moreBtn = hidden.length > 0
      ? `<div class="more-wrap">
          <div class="hidden-list" style="display:none">${hiddenRows}</div>
          <button class="more-btn" onclick="
            var hw=this.previousElementSibling;
            var open=hw.style.display!=='none';
            hw.style.display=open?'none':'block';
            this.textContent=open?'더보기 (${hidden.length}건) ▼':'접기 ▲';
            if(open){var s=this.closest('.section');var top=s.getBoundingClientRect().top+window.scrollY-window.innerHeight+s.offsetHeight+100;window.scrollTo({top:top,behavior:'smooth'});}
          ">더보기 (${hidden.length}건) ▼</button>
        </div>`
      : '';
    return `<div class="section">${header}<div class="notice-list">${visibleRows}</div>${moreBtn}</div>`;
  }

  const smpSection = `<div class="section smp-section">
    <div class="section-header" style="background:#b03a2e">
      <h2>📊 SMP 전력가격</h2>
      <a href="https://epsis.kpx.or.kr/epsisnew/selectEkmaSmpSmpChart.do?menuId=040201" class="site-link" target="_blank">실시간 보기 →</a>
    </div>
    ${smpBase64
      ? `<div style="padding:20px 22px;text-align:center"><img src="data:image/png;base64,${smpBase64}" style="max-width:100%;border-radius:8px" alt="SMP 차트"/></div>`
      : `<div class="empty-state">SMP 차트를 불러오지 못했습니다.<br/><a href="https://epsis.kpx.or.kr/epsisnew/selectEkmaSmpSmpChart.do?menuId=040201" target="_blank">직접 보기 →</a></div>`}
  </div>`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>⚡ 에너지본부 설계종합정보 - ${DISPLAY_DATE}</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Noto Sans KR',sans-serif;background:#f0f2f5;color:#333;padding:16px 24px}
    .wrapper{max-width:1100px;margin:0 auto}
    .header{background:linear-gradient(135deg,#0d1f4c,#1a3d7c);border-radius:14px;padding:32px 28px;margin-bottom:20px;color:#fff;text-align:center}
    .header h1{font-size:1.7rem;font-weight:700}
    .header .subtitle{margin-top:8px;font-size:.9rem;opacity:.8}
    .header .date-badge{display:inline-block;margin-top:14px;background:rgba(255,255,255,.15);border-radius:20px;padding:5px 18px;font-size:.85rem;font-weight:500}
    .section{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:20px;overflow:hidden;page-break-inside:avoid}
    .section-header{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;flex-wrap:wrap;gap:8px}
    .section-header h2{font-size:1rem;font-weight:700;color:#fff}
    .site-link{color:rgba(255,255,255,.85);font-size:.8rem;text-decoration:none;background:rgba(255,255,255,.15);padding:4px 12px;border-radius:20px}
    .notice-list{padding:6px 0}
    .notice-item{display:flex;align-items:center;padding:14px 22px;border-bottom:1px solid #f0f2f5;gap:12px}
    .notice-item:last-child{border-bottom:none}
    .notice-title{flex:1;font-size:.9rem;font-weight:500;color:#222;line-height:1.4}
    .new-badge{display:inline-block;font-size:.68rem;font-weight:700;color:#fff;background:#e53935;border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:middle;letter-spacing:.03em}
    .kcsc-type{display:inline-block;font-size:.72rem;font-weight:600;color:#5d4037;background:#efebe9;border-radius:4px;padding:1px 7px;margin-right:8px;vertical-align:middle}
    .kcsc-code{font-family:monospace;font-size:.82rem;color:#777;margin-right:10px;vertical-align:middle}
    .law-type{display:inline-block;font-size:.72rem;font-weight:600;color:#37474f;background:#eceff1;border-radius:4px;padding:1px 7px;margin-right:8px;vertical-align:middle;min-width:52px;text-align:center}
    .law-ministry{font-size:.75rem;color:#999;margin-left:6px;vertical-align:middle}
    .notice-date{flex-shrink:0;font-size:.78rem;color:#888;white-space:nowrap}
    .read-btn{flex-shrink:0;font-size:.78rem;font-weight:500;color:#555;text-decoration:none;border:1px solid #ddd;border-radius:6px;padding:4px 11px;white-space:nowrap}
    .empty-state{padding:24px;text-align:center;color:#aaa;font-size:.88rem;line-height:2}
    .empty-state a{color:#0072b8}
    .more-wrap{border-top:1px solid #f0f2f5;text-align:center;padding:8px 0 4px}
    .hidden-list{text-align:left}
    .more-btn{background:none;border:1px solid #ddd;border-radius:20px;padding:6px 20px;font-size:.8rem;color:#666;cursor:pointer;font-family:inherit}
    .more-btn:hover{background:#f5f5f5}
    .exclude-wrap{position:relative;display:inline-flex;align-items:center}
    .exclude-icon{font-size:.75rem;font-weight:600;color:rgba(255,255,255,.9);background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);border-radius:20px;padding:3px 10px;cursor:default;white-space:nowrap}
    .exclude-tooltip{display:none;position:absolute;right:0;top:calc(100% + 8px);background:#1a1a1a;color:#fff;font-size:.78rem;border-radius:8px;padding:10px 14px;white-space:normal;width:320px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.3);line-height:1.8}
    .exclude-tooltip::before{content:'';position:absolute;top:-5px;right:16px;border:5px solid transparent;border-bottom-color:#1a1a1a;border-top:none}
    .exclude-wrap:hover .exclude-tooltip{display:block}
    .footer{text-align:center;font-size:.78rem;color:#aaa;padding:10px 0 20px}
    .smp-section{page-break-before:always}
    @media(max-width:600px){.header h1{font-size:1.3rem}.notice-item{flex-direction:column;align-items:flex-start}}
  </style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>⚡ 에너지부문 설계종합정보</h1>
    <div class="subtitle">국가법령정보센터 · 국가건설기준센터 · 한국건설기술연구원 · 조달청 · 기후에너지환경부 · 한국에너지공단 · 한국환경공단 · 전기위원회 · 한국풍력산업협회 · 전력거래소 </div>
    <div class="date-badge">📅 ${DISPLAY_DATE} (${WEEKDAY})</div>
  </div>
  ${Object.entries(results).map(([id,r]) => noticeSection(id,r)).join('\n')}
  ${smpSection}
  <div class="footer">자동 생성 뉴스레터 · 생성 시각: ${new Date().toLocaleString('ko-KR')} · 데이터 출처: 각 기관 공식 홈페이지</div>
</div>
</body>
</html>`;
}

// ── 메인 ────────────────────────────────────────────────────
(async () => {
  console.log(`\n📰 뉴스레터 생성 시작 (${DISPLAY_DATE})\n`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,   // 비표준 포트·자체서명 인증서 사이트 대응 (g2b:8785 등)
  });
  // 각 스크래퍼마다 새 페이지를 생성해 이전 내비게이션 오류 전파 차단
  async function newPage() { return context.newPage(); }
  async function run(fn) {
    const p = await newPage();
    try { return await fn(p); } finally { await p.close().catch(() => {}); }
  }

  const results = {
    law:       await run(scrapeLaw),           // 1. 최신 법령
    adminRule: await run(scrapeAdminRule),     // 2. 최신 행정규칙
    kcsc:      await scrapeKcsc(),             // 3. 최신 설계기준 (HTTP 방식)
    kict:      await run(scrapeKict),          // 4. 공사비원가관리센터
    g2b:       await run(scrapeG2b),           // 5. 나라장터
    mcee:      await run(scrapeMcee),          // 6. 기후에너지환경부
    energy:    await run(scrapeEnergy),        // 7. 한국에너지공단
    keco:      await run(scrapeKeco),          // 8. 한국환경공단
    korec:     await run(scrapeKorec),         // 9. 전기위원회
    knrec:     await run(scrapeKnrec),         // 10. 신재생에너지센터
    kweia:     await run(scrapeKweia),         // 11. 한국풍력산업협회
  };                                           // 12. SMP 차트 (별도 섹션)
  const page = await newPage();
  const smpBase64 = await screenshotSmp(page);

  // HTML 저장
  const htmlContent = buildHtml(results, smpBase64);
  fs.writeFileSync(OUTPUT_FILE, htmlContent, 'utf-8');

  await browser.close();

  console.log(`\n✅ 완료`);
  console.log(`   📄 HTML: ${OUTPUT_FILE}`);
  Object.entries(results).forEach(([id,r]) =>
    console.log(`   ${SITE_META[id].emoji} ${SITE_META[id].name}: ${r.items.length}건 (날짜: ${r.items.filter(i=>i.date).length}건)`)
  );
  console.log(`   📊 SMP 차트: ${smpBase64 ? '캡처 성공' : '캡처 실패'}\n`);
})();
