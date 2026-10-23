// Khung E2E theo road-map pha — copy sang tools/guide-gen/_probe-<tinh-nang>.mjs rồi điền pha.
//   node _probe-<tinh-nang>.mjs [--role=student] [--count=6] [--resume=<id> --accounts=u1,u2,...]
// Cần: `yarn dev --port 7456 --strictPort` (VITE_GUIDE_HOOKS=1 nếu tự chơi trận), CMS_* trong tools/guide-gen/.env.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { readAccounts } from './lib/accounts-store.mjs';
import { leasePoolUnames, releasePoolAccounts, ssoLogin } from './lib/pool.mjs';
import { VIEWPORT } from './lib/page.mjs';

const ARGV = process.argv.slice(2);
const opt = (n, d = '') => ARGV.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const BASE = 'http://localhost:7456/luyen-tap';
const OUT = process.env.PROBE_OUT || path.resolve('_pr-feature');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Road-map: mỗi pha 1 dòng "══════ PHA", mỗi bước 1 dòng ✔/✘ — Monitor grep đúng 2 mẫu này ──
const results = [];
let phase = '';
let shotN = 0;
const setPhase = (p) => {
  phase = p;
  log(`══════ PHA ${p}`);
};
async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`) }).catch(() => {});
}
/** Một bước test: lỗi KHÔNG dừng cả lượt — ghi ✘ rồi đi tiếp để báo cáo đủ. */
async function step(role, name, fn) {
  log(`── [${role}] ${name}`);
  try {
    const note = await fn();
    results.push({ phase, role, name, ok: true, note: note ?? '' });
    log(`   ✔ ${note ?? ''}`);
    return true;
  } catch (e) {
    results.push({ phase, role, name, ok: false, note: e.message.split('\n')[0] });
    log(`   ✘ ${e.message.split('\n')[0]}`);
    return false;
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};

// ── Tài khoản THẬT từ pool (lease để lượt chạy song song không giành nhau) ──
// --role: vai của nhóm người dùng phụ (student / parent / coach…); --count: số tài khoản cần.
// Thêm điều kiện riêng của tính năng vào bộ lọc (ví dụ khối lớp) nếu cần.
const RESUME = Number(opt('resume', '0'));
const ROLE = opt('role', 'student');
const COUNT = Number(opt('count', '6'));
const all = readAccounts();
const pool = all.filter((a) => a.role === ROLE && a.status === 'profile_done' && a.gameUid);
const wanted = RESUME
  ? opt('accounts', '').split(',').filter(Boolean)
  : pool.map((a) => a.uname).sort(() => Math.random() - 0.5).slice(0, COUNT);
const got = await leasePoolUnames(wanted);
const S = (RESUME ? wanted : got).map((u) => pool.find((a) => a.uname === u));
log('Tài khoản', S.map((s, i) => `S${i + 1}=${s.uname}(${s.gameUid})`).join(' '));

// ── Helper UI ──
// Người dùng phụ (học sinh…) chạy headless; vai ĐIỀU HÀNH (HLV, admin…) mở cửa sổ thật để người
// chạy test theo dõi trực tiếp. Lazy: không có vai điều hành thì không bật cửa sổ thừa.
const browser = await chromium.launch({ headless: true });
let visibleBrowser = null;
const sessions = [];
async function openSession(acc, tag, { visible = false } = {}) {
  if (visible && !visibleBrowser) visibleBrowser = await chromium.launch({ headless: false, args: ['--window-size=1500,1100'] });
  const ctx = await (visible ? visibleBrowser : browser).newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`   [${tag}] pageerror`, e.message.slice(0, 160)));
  await ssoLogin(page, acc, { baseUrl: BASE });
  const s = { ctx, page, acc, tag };
  sessions.push(s);
  return s;
}
const btn = (page, name) => page.getByRole('button', { name, exact: true });
/** Nút mở modal xác nhận và nút xác nhận thường cùng nhãn — nút xác nhận là cái CUỐI. */
const clickLast = (page, name) => btn(page, name).last().click();
const bodyOf = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
/** Toast của core/Toast nằm trong khối z-[10050]; đọc ngay sau thao tác (toast tự tắt). */
async function toasts(page) {
  await sleep(1200);
  return (await page.locator('[class*="z-[10050]"]').allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ').trim();
}
// Khung modal riêng của module đang test — đổi selector theo component khung trong components/modals.
const MODAL_FRAME = '[role="dialog"]';
const modal = (page) => page.locator(MODAL_FRAME).last();
const closeModal = (page) => modal(page).getByRole('button', { name: 'Đóng', exact: true }).first().click();

try {
  if (!RESUME) {
    setPhase('1 · Khởi tạo');
    // await step('VAI', 'Mô tả bước', async () => { ...; expect(dieuKien, 'lý do'); return 'ghi chú'; });
  }
  setPhase('2 · Luồng chính');
  // ...
} catch (e) {
  log('DỪNG:', e.message);
} finally {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ accounts: S.map((s) => s.uname), results }, null, 2));
  console.log('\n===== KẾT QUẢ =====');
  let cur = '';
  for (const r of results) {
    if (r.phase !== cur) console.log(`\n# PHA ${(cur = r.phase)}`);
    console.log(`${r.ok ? '✔' : '✘'} [${r.role}] ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  }
  for (const s of sessions) await s.ctx.close().catch(() => {});
  await browser.close();
  await visibleBrowser?.close();
  releasePoolAccounts();
}
