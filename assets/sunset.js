// 停止服務通知（網頁版與外掛側邊欄共用）：功能已整併到「小編工具箱」（socialmediaeditor），本工具 2026/11/26 起停止服務。
// - 開啟就跳彈窗（前往小編工具箱＋公司功能需申請帳號），不能關閉；頁面其他部分設成 inert（滑鼠、鍵盤都點不到），等於停止運作。
// - 頁面的 CSP 不允許 inline script／style，所以 JS 與 CSS 都是獨立檔案，這裡也不用 inline style／onclick。
// - 自動化測試（navigator.webdriver）預設不顯示，避免既有 e2e 被彈窗擋住；要測彈窗本身時先設 window.__SUNSET_TEST = true。
(function () {
  const NEW_URL = 'https://unnn3ing-oss.github.io/socialmediaeditor/';
  const COMPANY = ['LINE 推播', '圖片套版', 'T寶貼圖・公司字型', 'FB 排程發布', '影片發布', '數據報表', '直播需求單'];
  if (navigator.webdriver && !window.__SUNSET_TEST) return;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function start() {
    const root = el('div'); root.id = 'sunset';
    const card = el('div', 'sn-card');
    card.setAttribute('role', 'alertdialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'sunsetTitle');
    const top = el('div', 'sn-top');
    const title = el('h2', null, '本工具已停止服務'); title.id = 'sunsetTitle';
    top.append(el('span', 'sn-tag', '停止服務通知'), title);
    const body = el('div', 'sn-body');
    const go = el('a', 'sn-go', '前往小編工具箱 →');
    go.href = NEW_URL; go.target = '_blank'; go.rel = 'noopener';
    const note = el('div', 'sn-note');
    const chips = el('div', 'sn-chips');
    for (const c of COMPANY) chips.append(el('i', null, c));
    const h3 = el('h3');
    h3.append(el('span', null, '🔒 請先以員工編號申請帳號，'), el('span', null, '才能使用完整功能'));   // 窄的時候在逗號後換行
    note.append(h3, chips);
    body.append(el('p', null, '功能已整併至「小編工具箱」，請改用新網站。'), go, note);
    card.append(top, body); root.append(card);
    for (const n of document.body.children) n.inert = true;
    document.body.append(root);
    document.documentElement.classList.add('sunset-locked');
    // Esc 不能關掉（例如頁面自己的 <dialog> 收到 Esc），一律攔下
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } }, true);
    go.focus({ preventScroll: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
