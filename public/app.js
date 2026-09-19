/* 英语学习工作台 - 前端逻辑 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  filter: 'today',
  words: [],
  activeWord: null,
  chatHistory: [],      // [{role, content, word}]
  chatSessionId: null,  // v1.2.0：当前聊天会话 id（持久化用）
  sessionWords: new Set(),
  sessionErrorWords: new Set(),
  sessionStartedAt: new Date().toISOString(),
  llmPresets: {},
  providers: [],        // AI 服务商档案列表
  activeProvId: '',     // 默认服务商 id
  useSearch: false,     // v1.0.7：联网搜索开关
  diyPrompts: {},       // v2.1.0：自定义提示词注册表（含索引/历史）
};

/* ---------------- 基础请求 ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
  return json;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/** v2.2.8：学习流水 kind 的展示标签，与服务端 VALID_ATTEMPT_KINDS 对齐 */
const ATTEMPT_KIND_LABELS = {
  word_quiz: '单词测验',
  unit_objective: '客观真题',
  translation: '真题翻译',
  writing: '真题写作',
  vocab_context: '语境选义',
  vocab_cloze: '搭配补全',
  sentence_analysis: '长难句三遍训练',
};

/** 语料中仅放行 <u>…</u>（阅读划线句忠实还原）；必须先 esc 再调用 */
function allowU(s) {
  return String(s ?? '').replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>');
}

/** 任何时间戳 → 北京时间 MM-DD HH:mm（服务器在哪个时区都不影响显示） */
function fmtBJ(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** 北京时间的 YYYY-MM-DD（前端本地统计用，如番茄钟按天归零） */
function bjDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}

/** 任意 ISO 时间 → 北京时间的 YYYY-MM-DD（用于「今天是否已同步」判断） */
function bjDateOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/** v2.1.0a 补齐：右下角轻提示（此前 toast 未定义，禅模式/白噪音调用会抛错） */
function toast(msg) {
  try {
    const old = document.querySelector('.wb-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { try { el.remove(); } catch { /* 静默 */ } }, 320);
    }, 2200);
  } catch { /* 静默 */ }
}

/* ================= v2.4.2：通用可折叠卡片（所有占版大的板块均可折叠） ================= */

/** 按 CSS 选择器折叠/展开卡片内容体；state=true 折叠，false 展开 */
function collapseCard(targetSel, state) {
  const body = $(targetSel);
  if (!body) return;
  body.classList.toggle('collapsed', !!state);
  const card = body.closest('.card-collapsible');
  const toggle = card && card.querySelector('.card-collapse-toggle');
  if (toggle) setCollapseToggleLabel(toggle, !!state);
}

function expandCard(targetSel) {
  collapseCard(targetSel, false);
}

function setCollapseToggleLabel(btn, collapsed) {
  btn.textContent = collapsed ? '展开 ▾' : '收起 ▴';
}

/* 全站折叠按钮事件委托：点按切换 data-collapse-target 指向的内容体 */
document.addEventListener('click', e => {
  const btn = e.target.closest('.card-collapse-toggle');
  if (!btn) return;
  const targetSel = btn.dataset.collapseTarget;
  if (!targetSel) return;
  const body = $(targetSel);
  if (!body) return;
  const nowCollapsed = !body.classList.contains('collapsed');
  collapseCard(targetSel, nowCollapsed);
});

/* ---------------- 发音（浏览器 TTS，零成本） ---------------- */

function speak(text, lang = 'en-US') {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = lang; u.rate = 0.92;
    speechSynthesis.speak(u);
  } catch { /* 浏览器不支持时静默 */ }
}

/** 从 AI 回复里提取英文句子朗读（例句场景），没有英文就读原词 */
function speakEnglishFrom(text, fallbackWord) {
  const sentences = String(text)
    .split(/[\n。！？!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 3 && (s.match(/[A-Za-z]/g) || []).length / s.replace(/\s/g, '').length > 0.6);
  if (sentences.length) speak(sentences.slice(0, 3).join(' '));
  else if (fallbackWord) speak(fallbackWord);
}

/* ---------------- 页签 ---------------- */

$$('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

function switchTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.bottom-tab-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'study') loadWords();
  if (name === 'notes') loadNotes();
  if (name === 'kb') loadKb();
  if (name === 'exam') loadExamList();
  if (name === 'unit') loadUnits();
  if (name === 'settings') { loadConfig(); loadBackupList(); }
  // quiz 页保持进行中的状态，不重置
}

// 快捷入口 / 链接跳转
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-jump]');
  if (!el) return;
  e.preventDefault();
  switchTab(el.dataset.jump);
  if (el.dataset.filter) {
    state.filter = el.dataset.filter;
    $$('#wordFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === state.filter));
    loadWords();
  }
});

/* ---------------- 仪表盘 ---------------- */

async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    // 同步引导条（v1.0.4）：从未同步 / 上次失败 / 今天没同步
    const banner = $('#syncBanner');
    const lastSyncDate = bjDateOf(d.lastSync);
    if (!d.lastSync) {
      $('#syncBannerText').textContent = '⚠️ 还没同步过数据——先同步一次，词表和进度才会出现';
      banner.style.display = 'flex';
    } else if (d.lastSyncOk === false) {
      $('#syncBannerText').textContent = `⚠️ 上次同步失败（${fmtBJ(d.lastSync)}），点击右侧重试`;
      banner.style.display = 'flex';
    } else if (lastSyncDate !== d.todayStr) {
      $('#syncBannerText').textContent = `⚠️ 今日数据未同步（上次同步 ${fmtBJ(d.lastSync)}），今日词表可能是空的`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
    // 统计卡
    if (d.progress) {
      $('#statProgress').textContent = `${d.progress.finished}/${d.progress.total}`;
      $('#statProgressSub').textContent = `还剩 ${Math.max(0, d.progress.total - d.progress.finished)} 个词`;
      const min = Math.round(d.progress.studyTimeMs / 60000);
      $('#statTime').textContent = min ? `${min} 分钟` : '—';
      $('#statTimeSub').textContent = min ? '继续保持 💪' : '今天还没开始学';
    } else {
      $('#statProgress').textContent = '—';
      $('#statProgressSub').textContent = '今天尚未同步';
    }
    $('#statSticky').textContent = d.counts.sticky;
    $('#statTotal').textContent = d.planTotal || '—';
    $('#statWordsSub').textContent = `本地已缓存 ${d.counts.words} 词 · 助记 ${d.counts.notes} 条`;

    // 复习量直方图
    const maxF = Math.max(1, ...d.forecast.map(x => x.count));
    $('#forecastBars').innerHTML = d.forecast.map(x => `
      <div class="bar-col">
        <div class="bar-num">${x.count || ''}</div>
        <div class="bar" style="height:${Math.max(2, x.count / maxF * 100)}%"></div>
        <div class="bar-label">${x.date.slice(5)}</div>
      </div>`).join('');

    // 进度曲线（移动端只显示最近 7 天，防止柱子过多拉扯布局）
    const isMobile = window.innerWidth <= 700;
    const histSlice = d.history.length ? (isMobile ? d.history.slice(-7) : d.history) : [{ date: '', finished: 0, total: 0 }];
    const maxH = Math.max(1, ...histSlice.map(x => x.finished));
    $('#historyBars').innerHTML = histSlice.map(x => `
      <div class="bar-col" title="${x.date}: ${x.finished}/${x.total}">
        <div class="bar-num">${x.finished || ''}</div>
        <div class="bar dim" style="height:${Math.max(2, x.finished / maxH * 100)}%"></div>
        <div class="bar-label">${x.date.slice(5)}</div>
      </div>`).join('');
    // 更新标题
    const histTitle = $('#historyBars')?.closest('.card')?.querySelector('.card-title');
    if (histTitle) histTitle.textContent = `学习成果曲线（最近 ${histSlice.length} 天）`;

    // v1.2.1：考研倒计时
    if (d.kaoyan) {
      const el = $('#kaoyanCountdown');
      if (el) {
        el.style.display = '';
        $('#countdownDays').textContent = d.kaoyan.daysLeft;
        $('#countdownDate').textContent = d.kaoyan.examDate;
        $('#streakDays').textContent = d.streak || 0;
      }
    }

    // v1.2.1：词汇掌握度分布
    if (d.mastery) {
      const m = d.mastery;
      const total = m.wellFamiliar + m.sticky + m.forget + m.vague + m.other;
      const pct = v => total ? Math.round(v / total * 100) : 0;
      const bar = $('#masteryBar');
      if (bar && total) {
        bar.innerHTML = `<div class="mastery-seg seg-ok" style="width:${pct(m.wellFamiliar)}%"></div>` +
          `<div class="mastery-seg seg-other" style="width:${pct(m.other)}%"></div>` +
          `<div class="mastery-seg seg-vague" style="width:${pct(m.vague)}%"></div>` +
          `<div class="mastery-seg seg-forget" style="width:${pct(m.forget)}%"></div>` +
          `<div class="mastery-seg seg-sticky" style="width:${pct(m.sticky)}%"></div>`;
      } else if (bar) {
        bar.innerHTML = '<div class="empty">同步后显示</div>';
      }
      const leg = $('#masteryLegend');
      if (leg) {
        leg.innerHTML = [
          `<span class="ml-item"><i class="ml-dot seg-ok"></i>熟练 ${m.wellFamiliar}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-other"></i>一般 ${m.other}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-vague"></i>模糊 ${m.vague}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-forget"></i>忘记 ${m.forget}</span>`,
          `<span class="ml-item"><i class="ml-dot seg-sticky"></i>顽固 ${m.sticky}</span>`,
        ].join('');
      }
    }

    // v1.2.1：测验与做题概况
    const qo = $('#quizOverview');
    if (qo) {
      const qs = d.quizStats || {};
      const us = d.unitStats || {};
      const parts = [];
      if (qs.total) parts.push(`<div><b>${qs.total}</b> 次单词测验 · <b>${qs.totalQ || 0}</b> 题 · 正确率 <b>${qs.avgRate || 0}%</b></div>`);
      if (us.total) parts.push(`<div><b>${us.total}</b> 次单元练习 · <b>${us.judged}</b> 题判分 · 正确 <b>${us.judged ? Math.round(us.correct / us.judged * 100) : 0}%</b></div>`);
      if (d.counts.sessions) parts.push(`<div><b>${d.counts.sessions}</b> 次 AI 学习会话 · <b>${d.counts.notes}</b> 条助记</div>`);
      qo.innerHTML = parts.length ? parts.join('') : '<div class="empty">还没做过测验，去试试吧</div>';
    }

    // 同步日志
    $('#syncLog').innerHTML = d.recentLog.length
      ? d.recentLog.map(l => `<li class="${l.ok ? 'log-ok' : 'log-fail'}">${fmtBJ(l.ts)} · ${esc(l.msg)}</li>`).join('')
      : '<li>暂无记录，点击右上角同步</li>';

    // v2.2.3：加载细粒度学习诊断周报
    loadLearningReport(state.reportDays || 7);

    // 首次使用提示
    const status = await api('/api/status');
    $('#setupHint').style.display = (!status.hasToken || !status.llm.configured) ? 'block' : 'none';
    updateSyncBadge(status.lastSync ? 'ok' : 'err', status.lastSync ? formatTime(status.lastSync) : '未同步');
  } catch (e) {
    console.error(e);
  }
}

// v2.0.0.a：前端每 30 秒静默轮询状态，若后台定时任务完成同步则无感更新同步红绿灯
setInterval(async () => {
  try {
    const status = await api('/api/status');
    if (status && status.lastSync) {
      updateSyncBadge(status.lastSyncOk ? 'ok' : 'err', formatTime(status.lastSync));
    }
  } catch {}
}, 30000);

function formatTime(iso) { return fmtBJ(iso); }

function updateSyncBadge(dotClass, text) {
  const dot = $('#syncDot');
  const txt = $('#syncText');
  if (dot) dot.className = 'dot ' + dotClass;
  if (txt) txt.textContent = text;

  const mDot = $('#mobileSyncDot');
  const mTxt = $('#mobileSyncText');
  if (mDot) mDot.className = 'dot ' + dotClass;
  if (mTxt) mTxt.textContent = text;
}

$('#syncBadge').addEventListener('click', () => doSync(false));
$('#bannerSyncBtn').addEventListener('click', () => doSync(false));

async function doSync(silent) {
  if (!silent) updateSyncBadge('loading', '同步中…');
  try {
    const r = await api('/api/sync', { method: 'POST' });
    updateSyncBadge(r.ok ? 'ok' : 'err', formatTime(new Date().toISOString()));
    if (!silent) {
      alert(r.ok ? '✅ 同步完成\n' + r.msg : '⚠️ 部分失败\n' + r.msg);
      loadDashboard();
    }
  } catch (e) {
    updateSyncBadge('err', '同步失败');
    if (!silent) alert('❌ ' + e.message);
  }
}

/* ---------------- v2.2.3：学习诊断周报 ---------------- */

async function loadLearningReport(days = 7) {
  state.reportDays = days;
  const labelEl = $('#reportWinLabel');
  if (labelEl) labelEl.textContent = `最近 ${days} 天`;
  $$('.report-win-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.days) === days);
  });

  const bodyEl = $('#learningReportBody');
  if (!bodyEl) return;

  try {
    const r = await api(`/api/learning/report?days=${days}`);
    renderLearningReport(r);
  } catch (err) {
    bodyEl.innerHTML = `<div class="result err">⚠️ 加载学习诊断周报失败: ${esc(err.message)}</div>`;
  }
}

function renderLearningReport(data) {
  const bodyEl = $('#learningReportBody');
  if (!bodyEl) return;

  const ov = data.overview || {};
  if (!ov.totalAttempts) {
    bodyEl.innerHTML = `
      <div class="report-empty">
        <div class="report-empty-icon">📊</div>
        <div class="report-empty-title">细粒度学习数据积累中</div>
        <div class="report-empty-sub">自 v2.2.0 起已启用单题级流水。在单词测验或真题单元中作答后，此处将自动呈现薄弱项、错因分布与信心校准。</div>
        <div class="report-empty-meta">数据启用时间: ${esc(data.enabledAt ? fmtBJ(data.enabledAt) : '近期')}</div>
      </div>`;
    return;
  }

  const accPct = ov.accuracy !== null ? Math.round(ov.accuracy * 100) + '%' : '—';
  const avgSec = ov.avgDurationMs ? (ov.avgDurationMs / 1000).toFixed(1) + 's' : '—';

  // 1. 核心指标网格
  const overviewHtml = `
    <div class="report-stat-grid">
      <div class="report-stat-box">
        <div class="report-stat-label">作答题量</div>
        <div class="report-stat-val">${ov.totalAttempts}</div>
        <div class="report-stat-sub">已判分: ${ov.judgedCount} 题</div>
      </div>
      <div class="report-stat-box">
        <div class="report-stat-label">客观准确率</div>
        <div class="report-stat-val ${ov.accuracy >= 0.7 ? 'ok' : 'warn'}">${accPct}</div>
        <div class="report-stat-sub">正确: ${ov.correctCount || 0} 题</div>
      </div>
      <div class="report-stat-box">
        <div class="report-stat-label">平均作答会话耗时</div>
        <div class="report-stat-val">${avgSec}</div>
        <div class="report-stat-sub">作答节奏</div>
      </div>
      <div class="report-stat-box">
        <div class="report-stat-label">主观输出</div>
        <div class="report-stat-val">${(data.subjective?.translationCount || 0) + (data.subjective?.essayCount || 0)}</div>
        <div class="report-stat-sub">翻译 ${data.subjective?.translationCount || 0} 篇 · 作文 ${data.subjective?.essayCount || 0} 篇</div>
      </div>
    </div>`;

  // 1b. 分题型统计（v2.2.8：六类 section 作答量/判分量/准确率）
  const secLabels = {
    vocabulary: '词汇',
    use_of_english: '完形填空',
    reading: '阅读理解',
    part_b: '新题型',
    translation: '翻译',
    writing: '写作',
  };
  const secOrder = ['vocabulary', 'use_of_english', 'reading', 'part_b', 'translation', 'writing'];
  const bySection = data.bySection || {};
  const bySecRows = secOrder
    .map(k => ({ k, v: bySection[k] || { total: 0, judged: 0, correct: 0, accuracy: null } }))
    .filter(x => x.v.total > 0 || x.v.judged > 0);
  const bySecHtml = bySecRows.length ? `
    <div class="report-section">
      <div class="report-sec-title">📚 分题型作答统计</div>
      <div class="report-sec-table">
        <div class="report-sec-row report-sec-head">
          <span class="sec-name">题型</span>
          <span class="sec-num">作答</span>
          <span class="sec-num">判分</span>
          <span class="sec-num">准确率</span>
        </div>
        ${bySecRows.map(({ k, v }) => `
          <div class="report-sec-row">
            <span class="sec-name">${esc(secLabels[k] || k)}</span>
            <span class="sec-num">${v.total}</span>
            <span class="sec-num">${v.judged}</span>
            <span class="sec-num ${v.accuracy !== null ? (v.accuracy >= 0.7 ? 'ok' : 'warn') : ''}">${v.accuracy !== null ? Math.round(v.accuracy * 100) + '%' : '—'}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // 2. 薄弱反复错词
  const repList = data.repeatedWords || [];  const repHtml = repList.length ? `
    <div class="report-section">
      <div class="report-sec-title">⚠️ 反复错词 / 顽固词（做错 ≥2 次）</div>
      <div class="report-tag-list">
        ${repList.map(w => `
          <button type="button" class="btn mini ghost report-word-tag" data-word="${esc(w.word)}">
            ${esc(w.word)} <span class="badge warn">${w.count}次</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  // 3. 错因分布
  const reasonLabels = {
    unknown_word: '生词障碍',
    misread_stem: '看错题干',
    evidence_missed: '定位遗漏',
    over_inference: '过度推断',
    option_trap: '选项陷阱',
    careless: '粗心手滑',
    time_pressure: '时间紧张',
    other: '其他原因',
  };
  const reasons = data.errorReasons || {};
  const reasonEntries = Object.entries(reasons).filter(([k, v]) => v > 0);
  const reasonHtml = reasonEntries.length ? `
    <div class="report-section">
      <div class="report-sec-title">🎯 客观题错因归因分布</div>
      <div class="report-reason-grid">
        ${reasonEntries.map(([k, v]) => `
          <div class="report-reason-item">
            <span class="reason-name">${reasonLabels[k] || k}</span>
            <span class="reason-count">${v} 次</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // 4. 信心校准矩阵
  const cm = data.confidenceMatrix || {};
  const confLabels = { sure: '🎯 确定', unsure: '🤔 犹豫', guess: '🎲 猜测' };
  const confHtml = `
    <div class="report-section">
      <div class="report-sec-title">⚖️ 作答信心与准确率校准</div>
      <div class="report-conf-grid">
        ${['sure', 'unsure', 'guess'].map(k => {
          const item = cm[k] || { total: 0, accuracy: null, correct: 0 };
          const p = item.accuracy !== null ? Math.round(item.accuracy * 100) + '%' : '—';
          return `
            <div class="report-conf-box">
              <div class="conf-head">${confLabels[k]}</div>
              <div class="conf-acc">${p}</div>
              <div class="conf-detail">${item.correct}/${item.total} 题正确</div>
            </div>`;
        }).join('')}
      </div>
    </div>`;

  // 5. 助记有效性评估（可解释模型追踪）
  const mn = data.mnemonicEffect || {};
  const mnHtml = mn.samples > 0 ? `
    <div class="report-section">
      <div class="report-sec-title">💡 助记促学效果追踪</div>
      <div class="report-mn-row">
        <span class="mn-badge ok">初步有效 ${mn.initialEffective}</span>
        <span class="mn-badge warn">待重写 ${mn.needsRewrite}</span>
        <span class="mn-badge sub">待验证 ${mn.pending}</span>
        <span class="mn-tip">（基于助记创建后的后续首测作答表现）</span>
      </div>
    </div>` : '';

  // 6. 待复测长难句任务（v2.2.5）
  const dueList = data.dueReviews || [];
  const dueHtml = dueList.length ? `
    <div class="report-section">
      <div class="report-sec-title">📅 待复测长难句（3 天周期）</div>
      <div class="report-due-list">
        ${dueList.map(d => `
          <button type="button" class="report-due-item" data-review-id="${esc(d.id)}" data-prompt="${esc(String(d.prompt || '').slice(0, 600))}">
            <span class="due-sentence">${esc(String(d.prompt || '').slice(0, 80))}${String(d.prompt || '').length > 80 ? '…' : ''}</span>
            <span class="due-badge">复测</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  // 5b. 待重试首答（v2.2.8：LLM 失败已存输入，尚未生成反馈，不计入作答统计）
  const retryList = data.pendingRetries || [];
  const pendingHtml = retryList.length ? `
    <div class="report-section">
      <div class="report-sec-title">⏳ 待重试长难句（AI 反馈未生成）</div>
      <div class="report-due-list">
        ${retryList.map(d => `
          <button type="button" class="report-retry-item" data-review-id="${esc(d.id)}" data-prompt="${esc(String(d.prompt || '').slice(0, 600))}">
            <span class="due-sentence">${esc(String(d.prompt || '').slice(0, 80))}${String(d.prompt || '').length > 80 ? '…' : ''}</span>
            <span class="due-badge warn">待重试</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  bodyEl.innerHTML = overviewHtml + bySecHtml + repHtml + reasonHtml + confHtml + mnHtml + pendingHtml + dueHtml;

  // 绑定反复错词点击跳转去学
  $$('#learningReportBody .report-word-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      const sp = btn.dataset.word;
      if (sp) {
        switchTab('study');
        $('#wordSearch').value = sp;
        loadWords();
      }
    });
  });

  // 绑定待复测长难句点击进入训练弹层
  $$('#learningReportBody .report-due-item').forEach(btn => {
    btn.addEventListener('click', () => {
      stOpenReview(btn.dataset.reviewId, btn.dataset.prompt, {});
    });
  });

  // 绑定待重试首答点击进入训练弹层（复用首答重做入口）
  $$('#learningReportBody .report-retry-item').forEach(btn => {
    btn.addEventListener('click', () => {
      stOpenRetry(btn.dataset.reviewId, btn.dataset.prompt);
    });
  });
}

// 绑定周报时间窗口切换按钮
$$('.report-win-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = Number(btn.dataset.days || 7);
    loadLearningReport(days);
  });
});

// 查看全部流水弹层
if ($('#reportViewAllBtn')) {
  $('#reportViewAllBtn').addEventListener('click', () => openReportModal());
}
if ($('#reportModalClose')) {
  $('#reportModalClose').addEventListener('click', () => {
    $('#reportModal').style.display = 'none';
  });
}
if ($('#reportKindFilter')) {
  $('#reportKindFilter').addEventListener('change', (e) => {
    loadReportModalList(e.target.value);
  });
}

async function openReportModal() {
  $('#reportModal').style.display = 'flex';
  const filter = $('#reportKindFilter') ? $('#reportKindFilter').value : '';
  loadReportModalList(filter);
}

async function loadReportModalList(kind = '') {
  const listEl = $('#reportModalList');
  const totEl = $('#reportModalTotal');
  if (!listEl) return;
  listEl.innerHTML = '<div class="hint">加载流水明细…</div>';

  try {
    const url = kind ? `/api/learning/attempts?kind=${encodeURIComponent(kind)}&limit=100` : '/api/learning/attempts?limit=100';
    const r = await api(url);
    const attempts = r.attempts || [];
    if (totEl) totEl.textContent = `共 ${r.total} 条（显示前 ${attempts.length} 条）`;

    if (!attempts.length) {
      listEl.innerHTML = '<div class="report-empty" style="padding:20px 0">暂无对应流水记录</div>';
      return;
    }

    listEl.innerHTML = attempts.map(a => {
      const isOk = a.result === 'correct';
      const isBad = a.result === 'incorrect';
      const resClass = isOk ? 'u-ok' : isBad ? 'u-bad' : '';
      const resText = isOk ? '✓ 正确' : isBad ? '✗ 错误' : (a.result || '待定');
      const timeStr = a.submittedAt || a.startedAt || '';
      return `
        <div class="report-attempt-item">
          <div class="att-head">
            <span class="tag">${esc(ATTEMPT_KIND_LABELS[a.kind] || a.kind)}</span>
            <span class="att-res ${resClass}">${resText}</span>
            <span class="att-conf">${a.confidence ? '信心: ' + esc(a.confidence) : ''}</span>
            <span class="att-time">${timeStr ? fmtBJ(timeStr) : ''}</span>
          </div>
          <div class="att-prompt"><b>题干:</b> ${esc(String(a.prompt || '').slice(0, 120))}</div>
          <div class="att-ans"><b>作答:</b> ${esc(String(a.answer || '').slice(0, 100))}${a.expected ? ` · <b>标准:</b> ${esc(String(a.expected).slice(0, 80))}` : ''}</div>
          ${a.errorReason ? `<div class="att-reason">错因标记: <span class="badge warn">${esc(a.errorReason)}</span></div>` : ''}
        </div>`;
    }).join('');

  } catch (err) {
    listEl.innerHTML = `<div class="result err">加载失败: ${esc(err.message)}</div>`;
  }
}

/* ---------------- AI 学习页 ---------------- */

$$('#wordFilters .chip').forEach(c => c.addEventListener('click', () => {
  $$('#wordFilters .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  state.filter = c.dataset.filter;
  loadWords();
}));

$('#wordSearch').addEventListener('input', debounce(loadWords, 300));
$('#wordSearch').addEventListener('keydown', e => { if (e.key === 'Enter') loadWords(); });

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function loadWords() {
  try {
    const q = $('#wordSearch').value.trim();
    const d = await api(`/api/words?filter=${state.filter}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    state.words = d.words;
    renderWordList();
    fetchGlosses();   // 后台补释义，不阻塞列表
  } catch (e) {
    $('#wordList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/** 批量补齐当前词表缺失的音标/释义（AI 词典缓存，失败静默） */
async function fetchGlosses() {
  const need = state.words.filter(w => !w.gloss).slice(0, 30).map(w => w.spelling);
  if (!need.length) return;
  try {
    const r = await api('/api/gloss', { method: 'POST', body: { spellings: need } });
    const got = r.glosses || {};
    if (!Object.keys(got).length) return;
    state.words.forEach(w => { if (got[w.spelling]) w.gloss = got[w.spelling]; });
    if ($('#tab-study').classList.contains('active')) renderWordList();
  } catch { /* 释义是增强功能，获取失败不影响主流程 */ }
}

function renderWordList() {
  const list = $('#wordList');
  if (!state.words.length) {
    list.innerHTML = '<div class="empty">没有符合条件的单词，试试其他筛选或先同步</div>';
    return;
  }
  const todayStr = bjDate();
  list.innerHTML = state.words.map(w => {
    let badge = '';
    if (w.tags?.includes('STICKING') || w.quizResponse === 'FORGET') badge = '<span class="badge sticky">顽固</span>';
    else if (w.today?.date === todayStr && w.today?.isNew) badge = '<span class="badge new">新词</span>';
    else if (w.today?.date === todayStr && w.today?.isFinished) badge = '<span class="badge done">已完成</span>';
    const meta = w.studyCount != null ? `学过 ${w.studyCount} 次` : (w.nextStudyDate ? '到期 ' + w.nextStudyDate.slice(5, 10) : '');
    const phon = w.gloss?.phonetic ? `<span class="phonetic">${esc(w.gloss.phonetic)}</span>` : '';
    const glossLine = w.gloss?.gloss ? `<div class="gloss-line" title="${esc(w.gloss.gloss)}">${esc(w.gloss.gloss)}</div>` : '<div class="gloss-line dim">　</div>';
    return `<div class="word-item ${state.activeWord === w.spelling ? 'active' : ''}" data-sp="${esc(w.spelling)}">
      <span class="word-main">
        <span class="spelling">${esc(w.spelling)} ${phon}</span>
        ${glossLine}
      </span>
      <span style="text-align:right;flex-shrink:0">${badge}<div class="meta">${meta}</div><button class="speak-btn mini" data-speak="${esc(w.spelling)}" title="朗读">🔊</button></span>
    </div>`;
  }).join('');
  $$('.word-item').forEach(el => el.addEventListener('click', () => selectWord(el.dataset.sp)));
  $$('.word-item .speak-btn').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();   // 不触发选中
    speak(b.dataset.speak);
  }));
}

function selectWord(spelling) {
  state.activeWord = spelling;
  renderWordList();
  $('#chatHeader').textContent = '当前学习：' + spelling;
  $('#speakWordBtn').style.display = 'inline-block';
  addMsg('ai', `📖 已切换到 **${spelling}**。想问什么？`, spelling);
  // v2.1.0：首句开场指令可在「设置 → DIY → 模型提示词」中自定义，{spacing} 占位符自动替换
  const tpl = (state.diyPrompts?.tutor_first_msg?.current)
    || '请介绍「{spelling}」的核心含义和常见考点/熟词僻义，还有最常用的搭配，然后等我提问。';
  askAI(tpl.replace(/\{spacing\}|\{spelling\}/g, spelling));
}

function addMsg(role, content, word) {
  const box = $('#chatMessages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const tag = word ? `<span class="word-tag">📘 ${esc(word)}</span>` : '';
  const spk = role === 'ai'
    ? `<button class="speak-btn mini msg-speak" title="朗读其中的英文例句">🔊</button>` : '';
  div.innerHTML = tag + mdLite(content) + spk;
  if (role === 'ai') div.dataset.raw = content;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// 事件委托：AI 消息上的朗读按钮
$('#chatMessages').addEventListener('click', (e) => {
  const btn = e.target.closest('.msg-speak');
  if (!btn) return;
  const msg = btn.closest('.msg');
  speakEnglishFrom(msg.dataset.raw || '', state.activeWord);
});

/* v1.0.8：发音优先韦氏真人 mp3（免费、官方 CDN），失败回退 TTS */
$('#speakWordBtn').addEventListener('click', async () => {
  const w = state.activeWord;
  if (!w) return;
  try {
    const r = await api('/api/dict/lookup?word=' + encodeURIComponent(w));
    if (r.entry?.audio) {
      new Audio(r.entry.audio).play().catch(() => speak(w));
      return;
    }
  } catch { /* 未配置词典 / 网络失败：TTS 兜底 */ }
  speak(w);
});

/** Markdown 渲染器（v1.2.0）：标题/加粗/斜体/删除线/行内代码/代码块/有序+无序列表/表格/引用/分隔线/链接/图片 */
function mdInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="md-img" src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?<![*\w])\*([^*]+?)\*(?![*\w])/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function mdLite(text) {
  const lines = esc(text).split('\n');
  const html = [];
  let ulOpen = false, olOpen = false;
  let table = [];
  let inCode = false, codeLang = '', codeLines = [];
  const closeUl = () => { if (ulOpen) { html.push('</ul>'); ulOpen = false; } };
  const closeOl = () => { if (olOpen) { html.push('</ol>'); olOpen = false; } };
  const closeLists = () => { closeUl(); closeOl(); };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table
      .map(r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()))
      .filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));
    if (rows.length) {
      const [head, ...rest] = rows;
      html.push('<table class="md-table"><thead><tr>' +
        head.map(c => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead>' +
        (rest.length ? '<tbody>' + rest.map(r => '<tr>' + r.map(c => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>' : '') +
        '</table>');
    } else {
      html.push(`<div>${table.map(mdInline).join('<br>')}</div>`);
    }
    table = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    // fenced code block （三反引号开闭）
    if (/^`{3}/.test(line.trim())) {
      if (!inCode) {
        closeLists(); flushTable();
        inCode = true; codeLang = line.trim().slice(3).trim(); codeLines = [];
      } else {
        html.push(`<pre class="md-code-block${codeLang ? ' lang-' + codeLang : ''}"><code>${codeLines.join('\n')}</code></pre>`);
        inCode = false; codeLang = ''; codeLines = [];
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    // table
    if (/^\s*\|.*\|\s*$/.test(line)) { closeLists(); table.push(line.trim()); continue; }
    flushTable();
    // empty
    if (!line.trim()) { closeLists(); html.push('<div class="md-gap"></div>'); continue; }
    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeLists(); html.push('<hr class="md-hr">'); continue; }
    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeLists(); html.push(`<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`); continue; }
    // blockquote（> 被 esc() 转成 &gt;）
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) { closeLists(); html.push(`<blockquote class="md-quote">${mdInline(bq[1])}</blockquote>`); continue; }
    // unordered list
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) {
      closeOl();
      if (!ulOpen) { html.push('<ul>'); ulOpen = true; }
      html.push(`<li>${mdInline(ul[1])}</li>`);
      continue;
    }
    // ordered list
    const oli = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (oli) {
      closeUl();
      if (!olOpen) { html.push(`<ol start="${oli[1]}">`); olOpen = true; }
      html.push(`<li>${mdInline(oli[2])}</li>`);
      continue;
    }
    closeLists();
    html.push(`<div>${mdInline(line)}</div>`);
  }
  if (inCode) html.push(`<pre class="md-code-block"><code>${codeLines.join('\n')}</code></pre>`);
  closeLists();
  flushTable();
  return html.join('');
}

/* v2.3.4：视觉能力——默认服务商开启 vision 后，可随提问附图片（OpenAI 兼容 image_url 内容块） */
let chatImage = '';   // 待发送图片 dataURL

function activeVisionEnabled() {
  const p = state.providers.find(x => x.id === state.activeProvId);
  return !!(p && p.vision);
}

function refreshVisionUI() {
  const btn = $('#chatImageBtn');
  if (btn) btn.style.display = activeVisionEnabled() ? '' : 'none';
}

/** 压缩输入图片：最长边 ≤1024px、JPEG 0.85，产出 dataURL（≤1.5MB 服务端红线） */
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, 1024 / Math.max(img.width, img.height, 1));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const dataURL = canvas.toDataURL('image/jpeg', 0.85);
          if (!dataURL.startsWith('data:image/')) throw new Error('图片编码失败');
          resolve(dataURL);
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function setChatImagePreview(dataURL) {
  chatImage = dataURL || '';
  const row = $('#chatImagePreview');
  if (!row) return;
  if (dataURL) {
    $('#chatImagePreviewImg').src = dataURL;
    row.style.display = 'flex';
  } else {
    row.style.display = 'none';
  }
}

$('#chatImageBtn').addEventListener('click', () => { const f = $('#chatImageFile'); f.value = ''; f.click(); });
$('#chatImageFile').addEventListener('change', async () => {
  const f = $('#chatImageFile').files && $('#chatImageFile').files[0];
  if (!f) return;
  try { setChatImagePreview(await compressImageFile(f)); }
  catch (e) { toast('🖼️ ' + (e.message || '图片处理失败')); }
});
$('#chatImageClear').addEventListener('click', () => setChatImagePreview(''));

async function askAI(message, isErrorMark = false) {
  if (!message.trim()) return;
  const image = chatImage;               // v2.3.4：捕获待发送图片后立即清空预览
  if (image) setChatImagePreview('');
  addMsg('user', message, state.activeWord);
  state.chatHistory.push({ role: 'user', content: message, word: state.activeWord });
  if (state.activeWord) {
    state.sessionWords.add(state.activeWord);
    if (isErrorMark) state.sessionErrorWords.add(state.activeWord);
    updateSessionInfo();
  }
  const loading = addMsg('ai', state.useSearch ? '🌐 正在联网搜索资料，然后思考中…' : '思考中…');
  loading.classList.add('loading');
  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: {
        spelling: state.activeWord,
        message,
        history: state.chatHistory.slice(-16).map(m => ({ role: m.role, content: m.content })),
        useSearch: !!state.useSearch,   // v1.0.7：联网搜索开关
        image: image || undefined,      // v2.3.4：视觉能力图片随问题发送
      },
    });
    loading.classList.remove('loading');
    let evidenceBadgeHtml = '';
    if (r.evidence) {
      const parts = [];
      if (r.evidence.examsCount > 0) parts.push(`<span class="evidence-pill exam" title="${esc(r.evidence.sampleExam || '真题库')}">🎓 真题 ×${r.evidence.examsCount}</span>`);
      if (r.evidence.externalCount > 0) parts.push(`<span class="evidence-pill external" title="${esc(r.evidence.sampleExternal || '外刊精选')}">📰 外刊 ×${r.evidence.externalCount}</span>`);
      if (r.evidence.corpusCount > 0) parts.push(`<span class="evidence-pill corpus" title="工作台手工语料">📚 语料 ×${r.evidence.corpusCount}</span>`);
      if (parts.length > 0) {
        evidenceBadgeHtml = `<div class="evidence-tags">${parts.join('')}</div>`;
      }
    }
    const currentWord = r.evidence?.spelling || state.activeWord;
    loading.innerHTML = (currentWord ? `<span class="word-tag">📘 ${esc(currentWord)}</span>` : '') + evidenceBadgeHtml + mdLite(r.reply);
    state.chatHistory.push({ role: 'assistant', content: r.reply, word: currentWord });
    autoSaveChat();   // v1.2.0：每次 AI 回复后自动持久化
  } catch (e) {
    loading.classList.remove('loading');
    loading.innerHTML = '❌ ' + esc(e.message) + (e.message.includes('AI 服务商') ? '（请到 设置 页配置）' : '');
  }
}

function updateSessionInfo() {
  $('#sessionInfo').textContent = `本次会话已学 ${state.sessionWords.size} 词` +
    (state.sessionErrorWords.size ? `（${state.sessionErrorWords.size} 个易错）` : '');
  $('#finishBtn').disabled = state.sessionWords.size === 0;
}

$('#sendBtn').addEventListener('click', () => {
  const v = $('#chatInput').value.trim();
  $('#chatInput').value = '';
  askAI(v);
});
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = $('#chatInput').value.trim(); $('#chatInput').value = ''; askAI(v); }
});

$$('#quickRow .chip.q').forEach(c => c.addEventListener('click', () => {
  if (c.id === 'imgGenChip') return;   // 生图走独立流程
  if (c.dataset.error && !state.activeWord) {
    addMsg('ai', '⚠️ 请先在左侧词表选中一个单词，再标记「我又忘了」。');
    return;
  }
  askAI(c.dataset.q, !!c.dataset.error);
}));

/* ================= v2.4.0：词文成章 —— 选词生成记忆文章 ================= */

const storyState = {
  quick: 'today', theme: '随缘',
  length: 'short',     // v2.4.3：唯一写入来源=AI 分析采纳（篇幅 chips 已删除）
  pool: [],            // 已选词（小写）
  current: null,       // 当前文章对象
  hist: [],            // 历史列表
  analysis: null,      // v2.4.2: AI词汇分析建议缓存
};
const STORY_TIP = {
  vocab: '词表精读 + AI 教练 + 助记生成，让单词过手入脑',
  story: '把选中的词写进一篇连贯短文：语境记忆 + 记忆钩子 + 检索自测，三管齐下',
};

async function switchStudySub(sub) {
  $$('#studySubbar .study-sub-item').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  const vocab = $('#vocabPane'), story = $('#storyPane');
  if (vocab) vocab.style.display = sub === 'vocab' ? '' : 'none';
  if (story) story.style.display = sub === 'story' ? '' : 'none';
  const tip = $('#studySubTip');
  if (tip) tip.textContent = STORY_TIP[sub] || '';
  if (sub === 'story') {
    /* v2.4.1：首次进入词文成章时若无题材 chips，先拉取题材渲染（loadConfig 只在设置页触发） */
    if (!$('#storyThemeRow .chip')) {
      try {
        const cfg = await api('/api/config');
        state.storyThemes = Array.isArray(cfg.storyThemes) ? cfg.storyThemes : null;
      } catch { /* 题材拉取失败回退前端内置清单 */ }
      renderStoryThemeRow(state.storyThemes);
    }
    if (!storyState.hist.length) loadStoryHist();
  } else loadWords();
}

$$('#studySubbar .study-sub-item').forEach(b => b.addEventListener('click', () => switchStudySub(b.dataset.sub)));

/* 快选词源 → 按墨墨筛选口径拉词，整组全部加入词池（不限数量） */
$$('#storyQuickRow .chip').forEach(c => c.addEventListener('click', () => {
  $$('#storyQuickRow .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  storyState.quick = c.dataset.quick;
  storyQuickFill();
}));

/* v2.4.1：题材 chips 改为动态渲染（renderStoryThemeRow），静态绑定移除 */
/* v2.4.3：篇幅规格 chips 已删除——篇幅全权由 AI 分析建议约束（storyState.length 仅由采纳建议写入） */

async function storyQuickFill() {
  const out = $('#storyAnalyzeResult') || $('#storyGenResult');
  try {
    const chipText = $('#storyQuickRow .chip.active')?.textContent || '当前词源';
    if (out) {
      out.textContent = '⏳ 正在按「' + chipText + '」抓取所有词汇…';
      out.className = 'result';
    }
    const d = await api(`/api/words?filter=${storyState.quick}`);
    const list = (d.words || []).map(w => w.spelling.toLowerCase());
    if (!list.length) {
      if (out) {
        out.textContent = '⚠️ 该词源下暂无单词，请先在仪表盘同步或切换词源';
        out.className = 'result err';
      }
      return;
    }
    // v2.4.2：直接将该词源下的全部词汇与当前词池合并去重，不设数量截断
    const next = [...new Set([...storyState.pool, ...list])];
    const addedCount = next.length - storyState.pool.length;
    storyState.pool = next;
    renderStoryPool();
    // 词池变动后，重置分析状态
    resetStoryAnalysis();
    if (out) {
      out.textContent = `✅ 成功载入「${chipText}」：新加入 ${addedCount} 词，当前词池共 ${storyState.pool.length} 词`;
      out.className = 'result ok';
    }
  } catch (e) {
    if (out) {
      out.textContent = '❌ ' + e.message;
      out.className = 'result err';
    }
  }
}

function renderStoryPool() {
  const pool = $('#storyPool');
  const clearBtn = $('#storyPoolClear');
  if (!storyState.pool.length) {
    pool.innerHTML = '<div class="hint">词池为空，先快选或搜索加入</div>';
    if (clearBtn) clearBtn.style.display = 'none';
    $('#storyPoolCount').textContent = '(0)';
    return;
  }
  pool.innerHTML = storyState.pool.map(w =>
    `<span class="story-pool-word" data-pw="${esc(w)}">${esc(w)}<button class="story-pool-x" data-pwx="${esc(w)}" title="移除" type="button">✕</button></span>`
  ).join('');
  $('#storyPoolCount').textContent = `(${storyState.pool.length})`;
  if (clearBtn) clearBtn.style.display = '';
  $$('#storyPool [data-pwx]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    storyState.pool = storyState.pool.filter(w => w !== b.dataset.pwx);
    renderStoryPool();
  }));
}

$('#storyAddBtn').addEventListener('click', () => {
  const inp = $('#storySearch');
  const raw = (inp.value || '').trim();
  if (!raw) return;
  // v2.4.2：支持逗号/空格/分号批量粘贴，统一小写去重加入（不限数量）
  const tokens = raw.split(/[,，;；\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return;
  const bad = tokens.filter(w => !/^[a-z][a-z''\-]{0,39}$/.test(w));
  if (bad.length >= tokens.length) { toast('⚠️ 仅支持英文单词（字母/撇号/连字符）'); return; }
  if (bad.length) toast(`⚠️ 跳过 ${bad.length} 个非法词：${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`);
  const before = storyState.pool.length;
  storyState.pool = [...new Set([...storyState.pool, ...tokens.filter(w => /^[a-z][a-z''\-]{0,39}$/.test(w))])];
  const added = storyState.pool.length - before;
  inp.value = '';
  renderStoryPool();
  resetStoryAnalysis();
  if (added) toast(`➕ 新加 ${added} 词，词池共 ${storyState.pool.length} 词`);
  else toast('已在词池中');
});
$('#storySearch').addEventListener('keydown', e => { if (e.key === 'Enter') $('#storyAddBtn').click(); });
$('#storyPoolClear').addEventListener('click', () => {
  storyState.pool = [];
  renderStoryPool();
  resetStoryAnalysis();
});

/* ================= v2.4.2：AI 词汇分析与规划（两阶段工作流·步骤一） ================= */

function resetStoryAnalysis() {
  storyState.analysis = null;
  const box = $('#storyAnalysisBox');
  if (box) box.style.display = 'none';
}

async function analyzeStoryWords() {
  const btn = $('#storyAnalyzeBtn'), out = $('#storyAnalyzeResult');
  if (!storyState.pool.length) {
    out.textContent = '⚠️ 词池为空——先点击上方词源快速选词或手动加入';
    out.className = 'result err';
    return;
  }
  btn.disabled = true;
  out.textContent = `🤖 AI 正在分析 ${storyState.pool.length} 个词汇的语义关联与考研场景…（约 10-30 秒）`;
  out.className = 'result';
  try {
    const r = await api('/api/story/analyze', { method: 'POST', body: { words: storyState.pool } });
    storyState.analysis = r.analysis || null;
    renderStoryAnalysis(storyState.analysis);
    out.textContent = '✅ 分析完成——请查阅建议并采纳，或手动微调下方参数';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ 分析失败：' + e.message;
    out.className = 'result err';
  } finally {
    btn.disabled = false;
  }
}
$('#storyAnalyzeBtn').addEventListener('click', analyzeStoryWords);

/** 渲染 AI 分析建议 */
function renderStoryAnalysis(a) {
  if (!a) return;
  const box = $('#storyAnalysisBox');
  if (!box) return;
  box.style.display = '';
  $('#storyAnalysisSummary').textContent = '💡 ' + (a.summary || '（无整体分析）');
  $('#storyLenRec').innerHTML =
    `<b>${esc(a.lengthLabel || '自适应篇幅')}</b>` +
    (a.lengthReason ? `<div style="margin-top:4px">${esc(a.lengthReason)}</div>` : '');
  const groups = Array.isArray(a.groups) ? a.groups : [];
  $('#storyGroupsList').innerHTML = groups.map(g => `
    <div class="story-group-item">
      <div class="story-group-title">🧩 ${esc(g.name || '未命名组')} <span class="story-hist-meta">题材建议：${esc(g.theme || '随缘')}</span></div>
      <div class="story-group-words">${esc((g.words || []).join(', '))}</div>
      <div class="story-group-plot">📖 ${esc(g.suggestedPlot || '')}</div>
    </div>`).join('') || '<div class="hint">无分组建议</div>';
}

/** 一键采纳：篇幅写入 storyState（v2.4.3 篇幅已无 chips，全权由 AI 建议约束）；题材按首选分组建议映射 */
$('#storyAdoptAdviceBtn').addEventListener('click', () => {
  const a = storyState.analysis;
  if (!a) { toast('⚠️ 请先完成分析'); return; }
  // 篇幅采纳（唯一来源：AI 建议）
  const lenKey = ['short', 'medium', 'long'].includes(a.recommendedLength) ? a.recommendedLength : null;
  if (lenKey) storyState.length = lenKey;
  // 题材采纳：第一个分组的 theme 与题材清单做包含匹配（如“校园/科技”→“校园”）
  const row = $('#storyThemeRow');
  const chips = row ? $$('#storyThemeRow .chip') : [];
  const suggested = (Array.isArray(a.groups) && a.groups[0] && a.groups[0].theme) || '';
  let matched = null;
  if (suggested) {
    for (const c of chips) {
      const t = c.dataset.theme || c.textContent.trim();
      if (suggested.includes(t) || (t && t.includes(suggested.split(/[\/／]/)[0].trim()))) { matched = c; break; }
    }
  }
  if (matched) {
    chips.forEach(x => x.classList.remove('active'));
    matched.classList.add('active');
    storyState.theme = matched.dataset.theme || matched.textContent.trim();
  }
  toast(`✅ 已采纳：篇幅=${lenKey || storyState.length}，题材=${storyState.theme}`);
});

/* 生成文章（v2.4.3：按 AI 分组逐篇生成，一次多篇；篇幅全权来自分析建议） */
async function generateStory() {
  const btn = $('#storyGenBtn'), out = $('#storyGenResult');
  if (storyState.pool.length < 1) {
    out.textContent = '⚠️ 词池为空，先点击上方词源快速选词';
    out.className = 'result err';
    return;
  }
  if (!storyState.analysis) {
    out.textContent = '⚠️ 请先完成「步骤一：AI 分析」——篇幅与分组由分析建议全权约束';
    out.className = 'result err';
    return;
  }
  btn.disabled = true;
  const a = storyState.analysis;
  const lenLabel = ({ short: '短篇', medium: '中篇', long: '长篇' })[storyState.length] || '短篇';
  const userInstruction = (a.summary || '') + (Array.isArray(a.groups) && a.groups.length ? ' 分组建议：' + a.groups.map(g => `${g.name}(${(g.words || []).length}词,${g.theme || ''}):${g.suggestedPlot || ''}`).join('；') : '');
  // v2.4.3：分组 ≥2 时按分组逐篇生成；否则全词池单篇
  const groups = (Array.isArray(a.groups) && a.groups.length >= 2)
    ? a.groups.map(g => ({ name: g.name || '', theme: g.theme || '', words: g.words || [], suggestedPlot: g.suggestedPlot || '' }))
    : [];
  const useGroups = groups.length >= 2 && groups.reduce((n, g) => n + g.words.length, 0) > 0;
  const totalPieces = useGroups ? groups.length : 1;
  out.textContent = useGroups
    ? `✨ AI 正在按 ${totalPieces} 个分组逐篇创作（0/${totalPieces}）…每篇约 20-60 秒`
    : `✨ AI 正在把 ${storyState.pool.length} 个词写进${storyState.theme}故事…（约 10-60 秒）`;
  out.className = 'result';
  try {
    const r = await api('/api/story/generate', {
      method: 'POST',
      body: {
        words: storyState.pool,
        groups: useGroups ? groups : undefined,
        theme: storyState.theme,
        length: storyState.length,
        lengthLabel: lenLabel,
        userInstruction,
      },
    });
    const stories = r.stories || (r.story ? [r.story] : []);
    const partialNote = r.partial ? `（${r.failed ? '「' + r.failed.group + '」失败：' + r.failed.error : ''}）` : '';
    out.textContent = `✅ 生成完成：共 ${stories.length} 篇${partialNote}`;
    out.className = 'result ok';
    if (stories.length) renderStory(stories[0]);
    loadStoryHist();
    // 折叠生成参数卡与选词卡，突出文章成果
    collapseCard('#storyParamBody', true);
    collapseCard('#storySelectBody', true);
    expandCard('#storyResultBody');
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  } finally {
    btn.disabled = false;
  }
}
$('#storyGenBtn').addEventListener('click', generateStory);

/** 高亮正文中的目标词（含基本变形）：整词匹配加粗 */
function highlightStoryWords(passage, words) {
  let html = esc(passage);
  const pats = words
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .map(w => `\\b${w}(?:s|es|ed|d|ing|ly)?\\b`)
    .sort((a, b) => b.length - a.length);
  for (const p of pats) {
    html = html.replace(new RegExp(p, 'gi'), m => `<b class="story-word" data-sw="${esc(m.toLowerCase())}">${m}</b>`);
  }
  return html.replace(/\n/g, '<br>');
}

function renderStory(s) {
  storyState.current = s;
  $('#storyResultCard').style.display = '';
  // v2.4.3：完成态徽章——done=true 绿色已完成 / false 黄色待做
  const badge = s.done ? '<span class="story-done-badge ok">✅ 已完成</span>' : '<span class="story-done-badge todo">📝 待做</span>';
  $('#storyTitle').innerHTML = `📖 ${esc(s.title)}（${esc(s.theme)} · ${s.words.length} 词）${badge}`;
  $('#storyPassage').innerHTML = highlightStoryWords(s.passage, s.words);
  $('#storyTranslation').textContent = s.translation || '（无翻译）';
  $('#storyHooks').innerHTML = (s.hooks || []).map(h => `
    <div class="story-hook">
      <b class="story-hook-word" data-sw="${esc(h.word.toLowerCase())}">${esc(h.word)}</b>
      <span class="story-hook-meta">${esc(h.phonetic || '')} ${esc(h.pos || '')}</span>
      <span class="story-hook-meaning">${esc(h.meaning || '')}</span>
      <button class="speak-btn mini story-hook-speak" data-spw="${esc(h.word)}" title="朗读">🔊</button>
      <div class="story-hook-line">🪝 ${esc(h.hook || '')}</div>
    </div>`).join('') || '<div class="hint">无钩子数据</div>';
  $$('#storyHooks [data-spw]').forEach(b => b.addEventListener('click', () => speak(b.dataset.spw)));
  renderStoryQuiz(s);
  $('#storyResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* 检索自测渲染与判分（v2.4.3：题数不限，全部作答后文章置「已完成」） */
function renderStoryQuiz(s) {
  const box = $('#storyQuiz'), res = $('#storyQuizResult');
  res.textContent = '';
  res.className = 'result';
  box.innerHTML = (s.quiz || []).map((q, i) => `
    <div class="story-quiz-item" data-qi="${i}">
      <div class="story-quiz-q">${i + 1}. ${esc(q.q)}</div>
      <div class="story-quiz-opts">${(q.options || []).map((o, j) =>
        `<button class="story-quiz-opt" data-qi="${i}" data-oj="${j + 1}" type="button">${'ABCD'[j]}. ${esc(o)}</button>`).join('')}</div>
    </div>`).join('') || '<div class="hint">无自测题</div>';
  const answers = (s.quiz || []).map(q => q.answer);
  const picked = {};
  let completedReported = false;
  $$('#storyQuiz .story-quiz-opt').forEach(b => b.addEventListener('click', () => {
    const qi = Number(b.dataset.qi), oj = Number(b.dataset.oj);
    if (picked[qi] !== undefined) return;   // 每题只答一次
    picked[qi] = oj;
    const correct = answers[qi] === oj;
    b.classList.add(correct ? 'correct' : 'wrong');
    if (!correct) {
      const opts = $$('#storyQuiz [data-qi="' + qi + '"] .story-quiz-opt');
      (opts.find ? opts.find(x => Number(x.dataset.oj) === answers[qi]) : opts.filter(x => Number(x.dataset.oj) === answers[qi])[0])?.classList.add('correct');
    }
    const done = Object.keys(picked).length;
    const right = Object.keys(picked).filter(k => picked[k] === answers[k]).length;
    res.textContent = `📊 已答 ${done}/${answers.length}，答对 ${right} 题`;
    res.className = 'result ' + (done === answers.length ? (right >= answers.length - 1 ? 'ok' : 'warn') : '');
    // v2.4.3：全部作答 → 上报完成态，标题徽章切换为绿色「已完成」
    if (done === answers.length && !completedReported && s.id) {
      completedReported = true;
      api(`/api/story/${s.id}/done`, { method: 'POST' })
        .then(() => {
          if (storyState.current && storyState.current.id === s.id) storyState.current.done = true;
          const badge = $('#storyTitle .story-done-badge');
          if (badge) { badge.textContent = '✅ 已完成'; badge.className = 'story-done-badge ok'; }
          toast('🎉 自测完成，文章已标记「已完成」');
          loadStoryHist();
        })
        .catch(() => {});
    }
  }));
}

/* 点词查义（正文加粗词/钩子词）：本地释义缓存优先，悬停小提示 + 朗读 */
document.addEventListener('click', e => {
  const w = e.target.closest('.story-word, .story-hook-word');
  if (!w) return;
  const word = w.dataset.sw || w.textContent.trim();
  speak(word);
  api('/api/gloss', { method: 'POST', body: { spellings: [word] } })
    .then(r => {
      const g = r.glosses?.[word];
      toast(g ? `📘 ${word} ${g.phonetic || ''} ${g.pos || ''} ${g.gloss || ''}` : '📘 ' + word + '（暂无释义缓存）');
    })
    .catch(() => {});
});

$('#storySpeakBtn').addEventListener('click', () => {
  const s = storyState.current;
  if (!s) return;
  speakEnglishFrom(s.passage, s.words[0]);
});
$('#storyCopyBtn').addEventListener('click', async () => {
  const s = storyState.current;
  if (!s) return;
  try {
    const hooks = (s.hooks || []).map(h => `- ${h.word} ${h.pos || ''} ${h.meaning || ''}｜钩子：${h.hook || ''}`).join('\n');
    await navigator.clipboard.writeText(`${s.title}\n\n${s.passage}\n\n【词汇钩子】\n${hooks}\n\n【译文】\n${s.translation || ''}`);
    toast('📋 已复制全文+钩子');
  } catch { toast('复制失败'); }
});
$('#storyDelBtn').addEventListener('click', async () => {
  const s = storyState.current;
  if (!s) return;
  if (!confirm('删除这篇文章？')) return;
  try {
    await api('/api/story/' + s.id, { method: 'DELETE' });
    $('#storyResultCard').style.display = 'none';
    storyState.current = null;
    toast('🗑 已删除');
    loadStoryHist();
  } catch (e) { toast('❌ ' + e.message); }
});

/* 历史文章列表与回看 */
async function loadStoryHist() {
  try {
    const d = await api('/api/story/list');
    storyState.hist = d.list || [];
    const box = $('#storyHistList');
    if (!storyState.hist.length) {
      box.innerHTML = '<div class="hint">还没有生成过文章</div>';
      return;
    }
    box.innerHTML = storyState.hist.map(s => `
      <div class="story-hist-item${s.done ? ' done' : ''}" data-sid="${esc(s.id)}">
        <div class="story-hist-main">
          <b>${esc(s.title)}</b>
          <span class="story-hist-meta">${esc(s.theme)} · ${s.words.length} 词 · ${s.quizCount || 0} 题 · ${fmtBJ(s.createdAt)}</span>
          <span class="story-hist-words">${esc(s.words.slice(0, 8).join(', '))}${s.words.length > 8 ? '…' : ''}</span>
        </div>
        <span class="story-done-badge ${s.done ? 'ok' : 'todo'}">${s.done ? '✅ 已完成' : '📝 待做'}</span>
        <button class="btn small" data-sload="${esc(s.id)}">查看</button>
      </div>`).join('');
    $$('#storyHistList [data-sload]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('/api/story/' + b.dataset.sload);
        renderStory(r.story);
      } catch (e) { toast('❌ ' + e.message); }
    }));
  } catch (e) {
    $('#storyHistList').innerHTML = `<div class="result err">加载失败: ${esc(e.message)}</div>`;
  }
}
$('#storyHistRefresh').addEventListener('click', loadStoryHist);

$('#storyRegenBtn').addEventListener('click', generateStory);

/* v1.0.6：AI 生图助记 —— 结合当前对话场景生成助记图并内联展示 */
$('#imgGenChip').addEventListener('click', async () => {
  if (!state.activeWord) {
    addMsg('ai', '⚠️ 请先在左侧词表选中一个单词，再生成助记图。');
    return;
  }
  const chip = $('#imgGenChip');
  chip.disabled = true;
  const loading = addMsg('ai', '🎨 正在结合当前对话场景生成助记图…（首次生成约需 10-30 秒）');
  loading.classList.add('loading');
  try {
    const r = await api('/api/image/gen', {
      method: 'POST',
      body: {
        spelling: state.activeWord,
        context: state.chatHistory.slice(-8).map(m => ({ role: m.role, content: m.content })),
      },
    });
    loading.classList.remove('loading');
    loading.innerHTML = `<span class="word-tag">📘 ${esc(state.activeWord)}</span>
      <div class="img-note">
        <img src="${esc(r.url)}" alt="${esc(state.activeWord)} 助记图" loading="lazy">
        ${r.caption ? `<div class="img-caption">🖼️ ${esc(r.caption)}</div>` : ''}
        <div class="img-prompt">画面提示词：${esc(r.prompt)}</div>
      </div>`;
    state.chatHistory.push({
      role: 'assistant', word: state.activeWord,
      content: `🎨 生成了「${state.activeWord}」的助记图：${r.caption || ''}`,
    });
  } catch (e) {
    loading.classList.remove('loading');
    loading.innerHTML = '❌ ' + esc(e.message) + (e.message.includes('生图服务商') ? '（请到 设置 页配置）' : '');
  } finally {
    chip.disabled = false;
  }
});

/* v1.0.7：联网搜索开关 —— 开启后每次提问先让服务端搜索实时资料注入上下文 */
$('#webSearchChip').addEventListener('click', () => {
  state.useSearch = !state.useSearch;
  $('#webSearchChip').classList.toggle('active', state.useSearch);
  addMsg('ai', state.useSearch
    ? '🌐 已开启联网搜索：之后每次提问会先搜索实时资料再回答（需在 设置 页配置搜索服务）。'
    : '🌐 已关闭联网搜索。');
});

/* v1.2.0：聊天记录自动持久化 —— 每次 AI 回复后自动保存到服务端 */
const _chatSaveTimer = { t: null };
function autoSaveChat() {
  clearTimeout(_chatSaveTimer.t);
  _chatSaveTimer.t = setTimeout(() => {
    if (state.chatHistory.length < 2) return;   // 至少一问一答才保存
    const title = state.activeWord
      ? `学习：${state.activeWord}`
      : (state.chatHistory.find(m => m.role === 'user')?.content?.slice(0, 30) || '对话');
    api('/api/chat/save', {
      method: 'POST',
      body: {
        id: state.chatSessionId,
        title,
        messages: state.chatHistory,
        createdAt: state.sessionStartedAt,
      },
    }).then(r => {
      if (r.id && !state.chatSessionId) state.chatSessionId = r.id;
    }).catch(() => { /* 保存失败静默 */ });
  }, 1500);   // 防抖 1.5s
}

/* v1.2.0：聊天历史面板 —— 查看/搜索/加载/删除历史对话 */
async function loadChatHistoryPanel() {
  const panel = $('#chatHistoryPanel');
  if (!panel) return;
  const q = $('#chatHistorySearch')?.value?.trim() || '';
  panel.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api('/api/chat/history' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!d.total) {
      panel.innerHTML = '<div class="empty">暂无历史对话' + (q ? '（试试其他搜索词）' : '') + '</div>';
      return;
    }
    let html = '';
    const days = Object.keys(d.groups).sort().reverse();
    for (const day of days) {
      const items = d.groups[day];
      html += `<div class="ch-day-header">${day === bjDate() ? '今天' : day}</div>`;
      for (const s of items) {
        const wordTags = (s.words || []).slice(0, 5).map(w => `<span class="tag type">${esc(w)}</span>`).join(' ');
        html += `<div class="ch-item" data-sid="${esc(s.id)}">
          <div class="ch-item-head">
            <b>${esc(s.title)}</b>
            <span class="ch-meta">${s.msgCount} 条消息 · ${fmtBJ(s.updatedAt || s.createdAt)}</span>
          </div>
          <div class="ch-words">${wordTags}</div>
          ${s.preview ? `<div class="ch-preview">${esc(s.preview)}</div>` : ''}
          <div class="ch-actions">
            <button class="btn small" data-load-chat="${esc(s.id)}">加载对话</button>
            <button class="btn small danger" data-del-chat="${esc(s.id)}">删除</button>
          </div>
        </div>`;
      }
    }
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function loadChatSession(id) {
  try {
    const d = await api(`/api/chat/session/${id}`);
    const s = d.session;
    // 恢复到当前聊天
    state.chatHistory = s.messages || [];
    state.chatSessionId = s.id;
    state.sessionStartedAt = s.createdAt;
    state.sessionWords = new Set(s.words || []);
    state.sessionErrorWords.clear();
    // 渲染消息
    const box = $('#chatMessages');
    box.innerHTML = '';
    for (const m of state.chatHistory) {
      addMsg(m.role === 'assistant' ? 'ai' : m.role, m.content, m.word);
    }
    if (s.words?.length) {
      state.activeWord = s.words[s.words.length - 1];
      $('#chatHeader').textContent = '当前学习：' + state.activeWord;
      $('#speakWordBtn').style.display = 'inline-block';
    }
    updateSessionInfo();
    // 切回聊天页
    if ($('#chatHistoryOverlay')) $('#chatHistoryOverlay').style.display = 'none';
  } catch (e) {
    alert('加载会话失败：' + e.message);
  }
}

async function deleteChatSession(id) {
  if (!confirm('确定删除这条聊天记录？')) return;
  try {
    await api(`/api/chat/session/${id}`, { method: 'DELETE' });
    loadChatHistoryPanel();
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

// 事件委托：聊天历史面板
document.addEventListener('click', (e) => {
  const loadBtn = e.target.closest('[data-load-chat]');
  if (loadBtn) { loadChatSession(loadBtn.dataset.loadChat); return; }
  const delBtn = e.target.closest('[data-del-chat]');
  if (delBtn) { deleteChatSession(delBtn.dataset.delChat); return; }
});

/* 结束会话 -> 生成助记 */
$('#finishBtn').addEventListener('click', async () => {
  if (!state.sessionWords.size) return;
  const btn = $('#finishBtn');
  btn.disabled = true;
  btn.textContent = '🤖 AI 正在总结助记…';
  try {
    const r = await api('/api/session/finish', {
      method: 'POST',
      body: {
        startedAt: state.sessionStartedAt,
        endedAt: new Date().toISOString(),
        words: [...state.sessionWords],
        errorWords: [...state.sessionErrorWords],
        messages: state.chatHistory,
      },
    });
    addMsg('ai', `🎉 本次学习结束！已为你生成 **${r.saved}** 条个性化助记，可在「助记库」查看并推送到墨墨 App。\n\n` +
      r.notes.map(n => `**${n.spelling}**（${n.noteType}）：${n.content}`).join('\n\n'));
    // 重置会话
    state.sessionWords.clear();
    state.sessionErrorWords.clear();
    state.chatHistory = [];
    state.chatSessionId = null;   // v1.2.0：重置持久化 id
    state.sessionStartedAt = new Date().toISOString();
    updateSessionInfo();
    btn.textContent = '✅ 结束本次学习并生成助记';
  } catch (e) {
    alert('生成助记失败：' + e.message);
    btn.textContent = '✅ 结束本次学习并生成助记';
    btn.disabled = state.sessionWords.size === 0;
  }
});

/* ---------------- 助记库 ---------------- */

async function loadNotes() {
  try {
    const q = $('#noteSearch').value.trim();
    const d = await api('/api/notes' + (q ? '?q=' + encodeURIComponent(q) : ''));
    $('#notesCount').textContent = d.notes.length;
    const list = $('#notesList');
    if (!d.notes.length) {
      list.innerHTML = '<div class="empty">还没有助记。去「AI 学习」页学习几个单词，结束后会自动生成。</div>';
      return;
    }
    list.innerHTML = d.notes.map(n => `
      <div class="note-item">
        <div class="note-word">${esc(n.spelling)}<small>${esc(n.source)} · ${fmtBJ(n.createdAt)}</small></div>
        <div class="note-body">
          <span class="tag type">${esc(n.noteType)}</span>
          <span class="tag ${n.synced ? 'synced' : 'pending'}">${n.synced ? '已推送墨墨' : '待推送'}</span>
          ${n.pushError ? `<div class="hint" style="margin:0;color:var(--warn)">${esc(n.pushError)}</div>` : ''}
          <div>${esc(n.content)}</div>
        </div>
        <div class="note-actions">
          ${n.synced ? '' : `<button class="btn small" data-push="${n.id}">推送到墨墨</button>`}
          <button class="btn small danger" data-del="${n.id}">删除</button>
        </div>
      </div>`).join('');

    $$('[data-push]').forEach(b => b.addEventListener('click', () => pushNote(b.dataset.push)));
    $$('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('确定删除这条助记？（本地删除，不影响墨墨 App 中已推送的）')) return;
      await api('/api/notes/' + b.dataset.del, { method: 'DELETE' });
      loadNotes();
    }));
  } catch (e) {
    $('#notesList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

$('#noteSearch').addEventListener('input', debounce(loadNotes, 300));

async function pushNote(id) {
  try {
    await api(`/api/notes/${id}/push`, { method: 'POST' });
    loadNotes();
  } catch (e) {
    alert('推送失败：' + e.message);
    loadNotes();
  }
}

/* 手动添加助记弹层 */
$('#addNoteBtn').addEventListener('click', () => {
  $('#noteModalTitle').textContent = '添加助记';
  $('#noteModalWord').value = state.activeWord || '';
  $('#noteModalContent').value = '';
  $('#noteModal').style.display = 'flex';
});
$('#noteModalCancel').addEventListener('click', () => $('#noteModal').style.display = 'none');
$('#noteModalSave').addEventListener('click', async () => {
  const word = $('#noteModalWord').value.trim();
  const content = $('#noteModalContent').value.trim();
  if (!word || !content) return alert('单词和内容都要填哦');
  try {
    await api('/api/notes', { method: 'POST', body: { spelling: word, noteType: $('#noteModalType').value, content } });
    $('#noteModal').style.display = 'none';
    loadNotes();
  } catch (e) { alert(e.message); }
});

/* ---------------- 主题（黑夜模式） ---------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $('#themeToggle');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  const mBtn = $('#mobileThemeToggle');
  if (mBtn) mBtn.textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('wb-theme', t);
}

$('#themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ---------------- 界面风格（白天模式主题） ---------------- */

function applyStyle(t) {
  document.documentElement.dataset.style = t;
  localStorage.setItem('wb-style', t);
  $$('#styleGrid .style-opt').forEach(b => b.classList.toggle('active', b.dataset.style === t));
}

$$('#styleGrid .style-opt').forEach(b => b.addEventListener('click', () => applyStyle(b.dataset.style)));

/* ---------------- 设置页 ---------------- */

let provPresets = {};

async function loadConfig() {
  try {
    const c = await api('/api/config');
    provPresets = c.presets || {};
    state.providers = c.llm.providers || [];
    state.activeProvId = c.llm.activeId;
    $('#provPreset').innerHTML = '<option value="">— 选择服务商 —</option>' +
      Object.entries(provPresets).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    $('#cfgMock').checked = !!c.llm.mock;
    if (c.hasToken) $('#cfgToken').placeholder = c.maimemoToken;
    $('#cfgAutoSync').checked = !!c.autoSync.enabled;
    $('#cfgSyncMinutes').value = c.autoSync.minutes || 60;
    /* v2.1.0：DIY 模型提示词注册表回填 */
    if (c.diyPrompts) {
      state.diyPrompts = c.diyPrompts;
      renderPromptRegistry();
    }
    /* v1.0.7：搜索服务配置回填 */
    if (c.searchPresets) {
      $('#cfgSearchPreset').innerHTML = '<option value="">— 手动填写 —</option>' +
        Object.entries(c.searchPresets).map(([k, v]) => `<option value="${esc(v.url)}">${esc(v.label)}</option>`).join('');
    }
    $('#cfgSearchUrl').value = c.webSearch?.url || '';
    if (c.webSearch?.hasKey) $('#cfgSearchKey').placeholder = '已保存 ✓（留空 = 沿用）';
    /* v1.0.8：韦氏词典 Key 状态提示 */
    if (c.dict?.hasLearners) $('#cfgDictLearners').placeholder = '已保存 ✓（留空 = 沿用）';
    if (c.mineru?.hasKey) $('#cfgMineruKey').placeholder = '已保存 ✓（留空 = 沿用）';
    if (c.dict?.hasCollegiate) $('#cfgDictCollegiate').placeholder = '已保存 ✓（留空 = 沿用）';
    /* v2.0.0.a：云词库回填与长期绑定状态持久化显示 */
    if (c.maimemoNotepadId) {
      const title = c.notepadTitle || '已绑定云词库';
      $('#cfgNotepad').innerHTML = `<option value="${esc(c.maimemoNotepadId)}" selected>${esc(title)}</option>`;
      $('#notepadResult').textContent = `✅ 当前已稳定绑定：${title}`;
      $('#notepadResult').className = 'result ok';
    } else {
      $('#cfgNotepad').innerHTML = '<option value="">— 未绑定 —</option>';
      $('#notepadResult').textContent = '';
      $('#notepadResult').className = 'result';
    }
    /* v1.1.7：AI 审核专用服务商回填 + v2.3.4：划词助手专用模型回填 */
    if (c.review) {
      const revSel = $('#cfgReviewProvider');
      if (revSel) {
        revSel.innerHTML = '<option value="">— 同默认服务商 —</option>' +
          (c.llm.providers || []).map(p => `<option value="${esc(p.id)}"${p.id === c.review.providerId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
      }
      const revModel = $('#cfgReviewModel');
      if (revModel) revModel.value = c.review.model || '';
      /* v2.4.1：审核专项「启用深度思考」开关已删除（统一收敛到服务商档案思考等级），不再回填 */
    }
    if (c.selection) {
      const selSel = $('#cfgSelectionProvider');
      if (selSel) {
        selSel.innerHTML = '<option value="">— 同默认服务商 —</option>' +
          (c.llm.providers || []).map(p => `<option value="${esc(p.id)}"${p.id === c.selection.providerId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
      }
      const selModel = $('#cfgSelectionModel');
      if (selModel) selModel.value = c.selection.model || '';
    }
    /* v2.4.1：词文成章专用模型回填 + DIY 文章题材编辑器回填 */
    if (c.story) {
      const storySel = $('#cfgStoryProvider');
      if (storySel) {
        storySel.innerHTML = '<option value="">— 同默认服务商 —</option>' +
          (c.llm.providers || []).map(p => `<option value="${esc(p.id)}"${p.id === c.story.providerId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
      }
      const storyModel = $('#cfgStoryModel');
      if (storyModel) storyModel.value = c.story.model || '';
    }
    state.storyThemes = Array.isArray(c.storyThemes) ? c.storyThemes : null;   // null = 内置默认
    renderStoryThemesEditor();
    renderStoryThemeRow(state.storyThemes);
    renderProviders();
    refreshVisionUI();   // v2.3.4：默认服务商视觉能力变化后同步图片按钮显隐
  } catch (e) { console.error(e); }
}

function renderProviders() {
  const list = $('#provList');
  if (!state.providers.length) {
    list.innerHTML = '<div class="empty-prov">还没有服务商，点右上角「＋ 添加服务商」</div>';
    return;
  }
  list.innerHTML = state.providers.map(p => `
    <div class="prov-item">
      <div class="prov-info">
        <div class="prov-name">${esc(p.name)} ${p.id === state.activeProvId ? '<span class="tag active">⭐ 默认</span>' : ''}</div>
        <div class="prov-meta">${esc(p.baseUrl || '未填 Base URL')} · ${esc(p.model || '未选模型')} · ${p.hasKey ? '🔑 已存 Key' : '⚠️ 无 Key'}${p.vision ? ' · <span class="prov-tag-mini">👁️ 视觉</span>' : ''}${p.thinking && p.thinking !== 'off' ? ` · <span class="prov-tag-mini">🧠 ${esc((THINK_META[p.thinking] || [p.thinking])[0])}</span>` : ''}${p.extraBody ? ' · <span class="prov-tag-mini">🔧 JSON</span>' : ''}</div>
      </div>
      <div class="prov-actions">
        ${p.id === state.activeProvId ? '' : `<button class="btn small" data-prov-active="${p.id}">设为默认</button>`}
        <button class="btn small" data-prov-test="${p.id}">测试</button>
        <button class="btn small" data-prov-edit="${p.id}">编辑</button>
        <button class="btn small danger" data-prov-del="${p.id}">删除</button>
      </div>
    </div>`).join('');

  $$('[data-prov-active]').forEach(b => b.addEventListener('click', () => setDefaultProvider(b.dataset.provActive)));
  $$('[data-prov-test]').forEach(b => b.addEventListener('click', () => testProvider(b.dataset.provTest, b)));
  $$('[data-prov-edit]').forEach(b => b.addEventListener('click', () => openProvModal(b.dataset.provEdit)));
  $$('[data-prov-del]').forEach(b => b.addEventListener('click', () => deleteProvider(b.dataset.provDel)));
}

async function saveProviders(providers) {
  await api('/api/config', { method: 'POST', body: { llm: { providers } } });
  await loadConfig();
}

/* v2.1.0：DIY 模型提示词注册表渲染 */
function renderPromptRegistry() {
  const box = $('#promptRegistry');
  if (!box) return;
  const entries = Object.entries(state.diyPrompts || {});
  if (!entries.length) {
    box.innerHTML = '<div class="hint">暂无可配置的提示词。</div>';
    return;
  }
  box.innerHTML = entries.map(([key, p]) => {
    const cur = p.current || p.template || '';
    const isCustom = p.current && p.current !== p.template;
    const history = Array.isArray(p.history) ? p.history : [];
    const historyHtml = history.length
      ? `<details class="prompt-history"><summary class="prompt-history-title">🕘 最近 ${history.length} 条历史版本</summary>` +
        history.map(h => `<div class="prompt-history-entry"><span class="ph-time">${esc(fmtBJ(h.time))}</span>${esc(String(h.text || '').slice(0, 400))}</div>`).join('') +
        '</details>'
      : '';
    return `
      <div class="prompt-item" data-pkey="${esc(key)}">
        <div class="prompt-item-head">
          <div>
            <span class="prompt-item-title">${esc(p.title || key)}</span>
            <span class="prompt-item-index">${esc(p.id || key)}</span>
          </div>
          ${isCustom ? '<span class="badge kb-badge-year">已自定义</span>' : '<span class="badge">默认</span>'}
        </div>
        <div class="prompt-item-desc">${esc(p.desc || '')}</div>
        <textarea data-prompt-text="${esc(key)}">${esc(cur)}</textarea>
        <div class="prompt-item-actions">
          <button class="btn small primary" data-prompt-save="${esc(key)}">💾 保存</button>
          <button class="btn small" data-prompt-preview="${esc(key)}">👀 预览默认</button>
          <button class="btn small ghost" data-prompt-reset="${esc(key)}">↺ 恢复默认</button>
          <span class="result" id="promptResult-${esc(key)}"></span>
        </div>
        ${historyHtml}
      </div>`;
  }).join('');

  $$('[data-prompt-save]').forEach(b => b.addEventListener('click', () => savePrompt(b.dataset.promptSave)));
  $$('[data-prompt-reset]').forEach(b => b.addEventListener('click', () => resetPrompt(b.dataset.promptReset)));
  $$('[data-prompt-preview]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.promptPreview;
    const p = state.diyPrompts[key];
    alert('【默认提示词 · ' + key + '】\n\n' + (p?.template || ''));
  }));
  const resetAll = $('#promptResetAllBtn');
  if (resetAll) resetAll.onclick = resetAllPrompts;
}

async function savePrompt(key) {
  const ta = $(`textarea[data-prompt-text="${key}"]`);
  const out = $('#promptResult-' + key);
  if (!ta || !out) return;
  try {
    await api('/api/config', { method: 'POST', body: { diyPrompts: { [key]: ta.value } } });
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
    await loadConfig();
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

async function resetPrompt(key) {
  if (!confirm('确定恢复「' + key + '」为默认提示词？当前自定义内容会存入历史。')) return;
  try {
    await api('/api/config', { method: 'POST', body: { diyPrompts: { [key]: { reset: true } } } });
    await loadConfig();
  } catch (e) { alert(e.message); }
}

async function resetAllPrompts() {
  if (!confirm('确定将所有提示词恢复为默认？当前自定义内容会存入各自历史。')) return;
  try {
    const body = {};
    const promptKeys = Object.keys(state.diyPrompts || {});
    for (const key of promptKeys) body[key] = { reset: true };
    await api('/api/config', { method: 'POST', body: { diyPrompts: body } });
    await loadConfig();
  } catch (e) { alert(e.message); }
}

async function setDefaultProvider(id) {
  try {
    await api('/api/config', { method: 'POST', body: { llm: { activeId: id } } });
    await loadConfig();
  } catch (e) { alert(e.message); }
}

async function deleteProvider(id) {
  if (!confirm('确定删除该服务商档案？（其 API Key 也会一并删除）')) return;
  try {
    const rest = state.providers.filter(p => p.id !== id);
    await saveProviders(rest);
  } catch (e) { alert(e.message); }
}

/* 服务商弹层（新增 / 编辑） */
let provEditId = '';

/* v2.4.4：思考强度 7 档滑块——档位字符串 ↔ 刻度互转与徽章渲染（2026-09 官方档案核实档位）
   唯一调节入口=设置页滑块；功能板块不注入思考参数（服务端只读档案 thinking 字段） */
const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const THINK_META = {
  off: ['关闭', '直出答案不思考；会显式下发关闭参数，兼容默认思考的模型'],
  minimal: ['极简', '极速浅思考，牺牲深度换取最快首字延迟'],
  low: ['低', '轻量思考，速度与成本均衡，适合多步决断与工具调用'],
  medium: ['中', '平衡档，多数任务的理想起点（规划 / 推理 / 判断）'],
  high: ['高', '高强度思考，复杂推理、深度规划与高价值任务'],
  xhigh: ['超高', '极深思考，面向深度研究与长程智能体任务'],
  max: ['拉满', '最深思考档，最复杂任务；与超高档建议对比后选用'],
};
function thinkStrToIdx(v) {
  const i = THINK_LEVELS.indexOf(String(v || 'off'));
  return i < 0 ? 0 : i;
}
function renderThinkBadge() {
  const el = $('#provThinking');
  if (!el) return;
  const idx = thinkStrToIdx(THINK_LEVELS[Number(el.value)] ? THINK_LEVELS[Number(el.value)] : 'off');
  const key = THINK_LEVELS[idx] || 'off';
  const [label, desc] = THINK_META[key] || THINK_META.off;
  const badge = $('#provThinkingBadge'), descEl = $('#provThinkingDesc');
  const wrap = $('#thinkSliderWrap');
  if (badge) { badge.textContent = label; badge.dataset.level = key; }
  if (descEl) descEl.textContent = desc;
  if (wrap) wrap.style.setProperty('--think-pct', (idx / (THINK_LEVELS.length - 1) * 100).toFixed(1) + '%');
}

function openProvModal(id) {
  provEditId = id || '';
  const p = id ? state.providers.find(x => x.id === id) : null;
  $('#provModalTitle').textContent = p ? '编辑服务商：' + p.name : '添加服务商';
  $('#provName').value = p?.name || '';
  $('#provPreset').value = '';
  $('#provUrl').value = p?.baseUrl || '';
  $('#provKey').value = '';
  $('#provKey').placeholder = p?.hasKey ? '已保存 Key（留空 = 沿用）' : '粘贴 API Key';
  $('#provModel').value = p?.model || '';
  $('#provTemp').value = p?.temperature !== undefined ? p.temperature : '';
  $('#provMaxTokens').value = p?.max_tokens !== undefined ? p.max_tokens : '';
  /* v2.3.4：模型服务高级三项回填；v2.4.4：思考等级改由滑块承载 */
  $('#provThinking').value = thinkStrToIdx(p?.thinking || 'off');
  renderThinkBadge();
  $('#provVision').checked = !!p?.vision;
  $('#provExtraBody').value = p?.extraBody || '';
  $('#provModelSelect').style.display = 'none';
  $('#provTestResult').textContent = '';
  $('#provTestResult').className = 'result';
  $('#provModal').style.display = 'flex';
}

$('#addProvBtn').addEventListener('click', () => openProvModal(''));
$('#provCancel').addEventListener('click', () => $('#provModal').style.display = 'none');
$('#provThinking').addEventListener('input', renderThinkBadge);   // v2.4.4：滑块拖动实时刷徽章与进度底色

$('#provPreset').addEventListener('change', () => {
  const pr = provPresets[$('#provPreset').value];
  if (pr) {
    // v2.1.0：预设自带完整模型参数（参考 Cherry Studio），一键填入地址、模型、温度与最大 token
    $('#provUrl').value = pr.baseUrl || '';
    $('#provModel').value = pr.model || '';
    $('#provTemp').value = pr.temperature !== undefined ? pr.temperature : '';
    $('#provMaxTokens').value = pr.max_tokens !== undefined ? pr.max_tokens : '';
    if (!$('#provName').value.trim()) $('#provName').value = pr.label || $('#provPreset').value;
  }
});

$('#provFetchBtn').addEventListener('click', async () => {
  const btn = $('#provFetchBtn'), sel = $('#provModelSelect');
  const baseUrl = $('#provUrl').value.trim();
  if (!baseUrl) return alert('请先填写 Base URL');
  btn.textContent = '拉取中…'; btn.disabled = true;
  try {
    const r = await api('/api/llm/models', {
      method: 'POST',
      body: {
        baseUrl,
        apiKey: $('#provKey').value.trim() || undefined,
        providerId: provEditId || undefined,
      },
    });
    if (!r.models.length) throw new Error('服务商返回了空列表');
    sel.style.display = 'block';
    sel.innerHTML = `<option value="">— 共 ${r.models.length} 个模型，点选自动填入 —</option>` +
      r.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  } catch (e) {
    sel.style.display = 'none';
    alert('拉取失败：' + e.message);
  }
  btn.textContent = '🔄 拉取'; btn.disabled = false;
});

$('#provModelSelect').addEventListener('change', () => {
  if ($('#provModelSelect').value) $('#provModel').value = $('#provModelSelect').value;
});

$('#provTestBtn').addEventListener('click', async () => {
  $('#provTestResult').textContent = '测试中…';
  $('#provTestResult').className = 'result';
  try {
    const r = await api('/api/test/llm', {
      method: 'POST',
      body: {
        baseUrl: $('#provUrl').value.trim() || undefined,
        apiKey: $('#provKey').value.trim() || undefined,
        model: $('#provModel').value.trim() || undefined,
        providerId: provEditId || undefined,
      },
    });
    $('#provTestResult').textContent = '✅ ' + r.msg;
    $('#provTestResult').className = 'result ok';
  } catch (e) {
    $('#provTestResult').textContent = '❌ ' + e.message;
    $('#provTestResult').className = 'result err';
  }
});

$('#provSave').addEventListener('click', async () => {
  const name = $('#provName').value.trim();
  const baseUrl = $('#provUrl').value.trim();
  const model = $('#provModel').value.trim();
  if (!name) return alert('给服务商起个名字');
  if (!baseUrl || !model) return alert('Base URL 和模型都要填');
  const key = $('#provKey').value.trim();
  const item = { name, baseUrl, model };
  const tempVal = $('#provTemp').value.trim();
  const maxTokVal = $('#provMaxTokens').value.trim();
  if (tempVal !== '') item.temperature = Number(tempVal);
  if (maxTokVal !== '') item.max_tokens = Number(maxTokVal);
  /* v2.3.4：模型服务高级三项保存（透传 JSON 先本地校验，防打手误存）；v2.4.4：思考强度读滑块刻度 */
  item.thinking = THINK_LEVELS[Number($('#provThinking').value) || 0] || 'off';
  item.vision = $('#provVision').checked;
  const extraRaw = $('#provExtraBody').value.trim();
  if (extraRaw) {
    try {
      const parsed = JSON.parse(extraRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
    } catch (e) { return alert('透传 JSON 参数格式错误：' + e.message); }
  }
  item.extraBody = extraRaw;
  if (provEditId) item.id = provEditId;
  if (key) item.apiKey = key;
  const providers = provEditId
    ? state.providers.map(p => (p.id === provEditId ? { ...p, ...item } : { ...p }))
    : [...state.providers, item];
  try {
    await saveProviders(providers);
    $('#provModal').style.display = 'none';
  } catch (e) { alert(e.message); }
});

$('#cfgMock').addEventListener('change', async () => {
  try { await api('/api/config', { method: 'POST', body: { llm: { mock: $('#cfgMock').checked } } }); }
  catch (e) { alert(e.message); }
});
/* v1.1.7：保存 AI 审核专用服务商 */
$('#saveReviewCfgBtn').addEventListener('click', async () => {
  const btn = $('#saveReviewCfgBtn');
  const prev = btn.textContent;
  try {
    btn.disabled = true;
    await api('/api/config', { method: 'POST', body: { review: {
      providerId: $('#cfgReviewProvider').value,
      model: $('#cfgReviewModel').value.trim(),
      // v2.4.1：thinking 不再由本卡管理（未提交该字段 → 服务端保留已存值），深度思考统一走服务商档案思考等级
    } } });
    btn.textContent = '✅ 已保存';
    setTimeout(() => { btn.textContent = prev; }, 2000);
  } catch (e) {
    alert('保存失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

/* v2.3.4：保存划词助手专用模型配置 */
$('#saveSelectionCfgBtn').addEventListener('click', async () => {
  const btn = $('#saveSelectionCfgBtn');
  const prev = btn.textContent;
  try {
    btn.disabled = true;
    await api('/api/config', { method: 'POST', body: { selection: {
      providerId: $('#cfgSelectionProvider').value,
      model: $('#cfgSelectionModel').value.trim(),
    } } });
    btn.textContent = '✅ 已保存';
    setTimeout(() => { btn.textContent = prev; }, 2000);
  } catch (e) {
    alert('保存失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

/* v2.4.1：保存词文成章专用模型配置 */
$('#saveStoryCfgBtn').addEventListener('click', async () => {
  const btn = $('#saveStoryCfgBtn');
  const prev = btn.textContent;
  try {
    btn.disabled = true;
    await api('/api/config', { method: 'POST', body: { story: {
      providerId: $('#cfgStoryProvider').value,
      model: $('#cfgStoryModel').value.trim(),
    } } });
    btn.textContent = '✅ 已保存';
    setTimeout(() => { btn.textContent = prev; }, 2000);
  } catch (e) {
    alert('保存失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

/* ================= v2.4.1：DIY · 文章题材编辑器（词文成章题材自定义） ================= */

const STORY_THEMES_FALLBACK = ['随缘', '校园', '科幻', '悬疑', '职场', '旅行', '童话', '冒险', '美食', '体育', '侦探', '西部', '宫斗', '末日', '神话', '赛博朋克'];

function storyThemesWorking() {
  return [...(state.storyThemesEdit || state.storyThemes || STORY_THEMES_FALLBACK)];
}

/** DIY 编辑器渲染（增/删，保存时统一提交） */
function renderStoryThemesEditor() {
  const list = $('#storyThemesList');
  if (!list) return;
  const items = storyThemesWorking();
  if (!items.length) {
    list.innerHTML = '<div class="hint">列表为空——保存后将回退到内置 16 题材</div>';
    return;
  }
  list.innerHTML = items.map((t, i) => `
    <span class="story-theme-tag${t === '随缘' ? ' locked' : ''}" data-ti="${i}">${esc(t)}
      ${t === '随缘' ? '<span class="story-theme-lock" title="默认题材，不可删除">🔒</span>' : `<button class="story-theme-x" data-tx="${i}" title="移除" type="button">✕</button>`}
    </span>`).join('');
  $$('#storyThemesList [data-tx]').forEach(b => b.addEventListener('click', () => {
    const cur = storyThemesWorking();
    cur.splice(Number(b.dataset.tx), 1);
    state.storyThemesEdit = cur;
    renderStoryThemesEditor();
  }));
}

$('#storyThemeAddBtn').addEventListener('click', () => {
  const inp = $('#storyThemeInput');
  const t = (inp.value || '').trim();
  if (!t) return;
  const cur = storyThemesWorking();
  if (cur.includes(t)) { toast('题材已存在'); return; }
  if (t.length > 12) { toast('题材 ≤12 字'); return; }
  if (cur.length >= 40) { toast('最多 40 个题材'); return; }
  cur.push(t);
  state.storyThemesEdit = cur;
  inp.value = '';
  renderStoryThemesEditor();
});
$('#storyThemeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#storyThemeAddBtn').click(); });

$('#storyThemesSaveBtn').addEventListener('click', async () => {
  const btn = $('#storyThemesSaveBtn'), out = $('#storyThemesResult');
  try {
    btn.disabled = true;
    const cur = storyThemesWorking();
    await api('/api/config', { method: 'POST', body: { storyThemes: cur.length >= 2 ? cur : null } });
    state.storyThemes = cur.length >= 2 ? cur : null;
    state.storyThemesEdit = null;
    renderStoryThemesEditor();
    renderStoryThemeRow(state.storyThemes);
    out.textContent = '✅ 题材已保存，词文成章页已生效';
    out.className = 'result ok';
    setTimeout(() => { out.textContent = ''; }, 2500);
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  } finally {
    btn.disabled = false;
  }
});

$('#storyThemesResetBtn').addEventListener('click', async () => {
  const out = $('#storyThemesResult');
  try {
    await api('/api/config', { method: 'POST', body: { storyThemes: null } });
    state.storyThemes = null;
    state.storyThemesEdit = null;
    renderStoryThemesEditor();
    renderStoryThemeRow(null);
    out.textContent = '↺ 已恢复内置题材';
    out.className = 'result ok';
    setTimeout(() => { out.textContent = ''; }, 2500);
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/** 词文成章页题材 chips 动态渲染（自定义列表优先，随缘固定首位） */
function renderStoryThemeRow(customList) {
  const row = $('#storyThemeRow');
  if (!row) return;
  const themes = (Array.isArray(customList) && customList.length >= 2 ? customList : STORY_THEMES_FALLBACK);
  const ordered = ['随缘', ...themes.filter(t => t !== '随缘')];
  const cur = storyState.theme && ordered.includes(storyState.theme) ? storyState.theme : ordered[0];
  storyState.theme = cur;
  row.innerHTML = ordered.map(t => `<button class="chip${t === cur ? ' active' : ''}" data-theme="${esc(t)}" type="button">${esc(t)}</button>`).join('');
  $$('#storyThemeRow .chip').forEach(c => c.addEventListener('click', () => {
    $$('#storyThemeRow .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    storyState.theme = c.dataset.theme;
  }));
}

/* v1.0.6：云词库绑定 */
$('#loadNotepadsBtn').addEventListener('click', async () => {
  const btn = $('#loadNotepadsBtn'), sel = $('#cfgNotepad'), out = $('#notepadResult');
  btn.textContent = '拉取中…'; btn.disabled = true;
  out.textContent = ''; out.className = 'result';
  try {
    const r = await api('/api/notepads');
    if (!r.notepads.length) {
      sel.innerHTML = '<option value="">— 账号下没有云词库 —</option>';
      out.textContent = '⚠️ 账号下没有云词库/收藏本，请先在墨墨 App 里创建一个，再回来绑定';
      out.className = 'result err';
      return;
    }
    const typeLabel = t => (t === 'FAVORITE' ? '收藏本' : t === 'NOTEPAD' ? '云词本' : (t || ''));
    sel.innerHTML = '<option value="">— 未绑定 —</option>' + r.notepads.map(np =>
      `<option value="${esc(np.id)}" ${np.id === r.boundId ? 'selected' : ''}>${esc(np.title)}（${typeLabel(np.type)}）</option>`
    ).join('');
    out.textContent = `✅ 共 ${r.notepads.length} 个，选择后自动保存绑定`;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  } finally {
    btn.textContent = '拉取云词库列表'; btn.disabled = false;
  }
});

$('#cfgNotepad').addEventListener('change', async () => {
  const sel = $('#cfgNotepad'), out = $('#notepadResult');
  const id = sel.value;
  const title = id ? (sel.options[sel.selectedIndex]?.textContent || '').trim() : '';
  try {
    await api('/api/config', { method: 'POST', body: { maimemoNotepadId: id, notepadTitle: title } });
    out.textContent = id ? `✅ 已永久绑定云词库「${title}」，之后推送助记会自动将单词入库` : '已解绑';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v1.0.6：生图服务商配置 */
$('#saveImageBtn').addEventListener('click', async () => {
  const out = $('#imageTestResult');
  try {
    await api('/api/config', {
      method: 'POST',
      body: {
        imageGen: {
          baseUrl: $('#cfgImgUrl').value.trim(),
          model: $('#cfgImgModel').value.trim(),
          apiKey: $('#cfgImgKey').value.trim() || undefined,   // 留空沿用
        },
      },
    });
    $('#cfgImgKey').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testImageBtn').addEventListener('click', async () => {
  const out = $('#imageTestResult');
  // 先保存表单里的值再测（允许不先保存直接测）
  try {
    await api('/api/config', {
      method: 'POST',
      body: {
        imageGen: {
          baseUrl: $('#cfgImgUrl').value.trim(),
          model: $('#cfgImgModel').value.trim(),
          apiKey: $('#cfgImgKey').value.trim() || undefined,
        },
      },
    });
    $('#cfgImgKey').value = '';
  } catch { /* 测试时如实暴露错误 */ }
  out.textContent = '🎨 生成测试图中…（约 10-30 秒）';
  out.className = 'result';
  try {
    const r = await api('/api/test/image', { method: 'POST' });
    out.innerHTML = `✅ 生图成功！<img class="test-img" src="${esc(r.url)}" alt="测试图">`;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v1.0.7：网络搜索服务配置 */
function buildSearchBody() {
  return {
    webSearch: {
      url: $('#cfgSearchUrl').value.trim(),
      apiKey: $('#cfgSearchKey').value.trim() || undefined,   // 留空沿用
    },
  };
}

$('#cfgSearchPreset').addEventListener('change', () => {
  const url = $('#cfgSearchPreset').value;
  if (url) $('#cfgSearchUrl').value = url;
});

$('#saveSearchBtn').addEventListener('click', async () => {
  const out = $('#searchTestResult');
  try {
    await api('/api/config', { method: 'POST', body: buildSearchBody() });
    $('#cfgSearchKey').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testSearchBtn').addEventListener('click', async () => {
  const out = $('#searchTestResult');
  // 先保存表单里的值再测（允许不先保存直接测）
  try { await api('/api/config', { method: 'POST', body: buildSearchBody() }); $('#cfgSearchKey').value = ''; }
  catch { /* 测试时如实暴露错误 */ }
  out.textContent = '🔍 搜索测试中…';
  out.className = 'result';
  try {
    const r = await api('/api/test/search', { method: 'POST' });
    out.textContent = `✅ ${r.msg} · 首条：${r.sample}`;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v1.0.8：韦氏词典双 Key 配置 */
function buildDictBody() {
  return {
    dict: {
      learnersKey: $('#cfgDictLearners').value.trim() || undefined,     // 留空沿用
      collegiateKey: $('#cfgDictCollegiate').value.trim() || undefined,
    },
  };
}

$('#saveDictBtn').addEventListener('click', async () => {
  const out = $('#dictTestResult');
  try {
    await api('/api/config', { method: 'POST', body: buildDictBody() });
    $('#cfgDictLearners').value = '';
    $('#cfgDictCollegiate').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testDictBtn').addEventListener('click', async () => {
  const out = $('#dictTestResult');
  // 先保存表单里的值再测（允许不先保存直接测）
  try { await api('/api/config', { method: 'POST', body: buildDictBody() }); $('#cfgDictLearners').value = ''; $('#cfgDictCollegiate').value = ''; }
  catch { /* 测试时如实暴露错误 */ }
  out.textContent = '📖 查询「resilient」测试中…';
  out.className = 'result';
  try {
    const r = await api('/api/test/dict', { method: 'POST' });
    out.textContent = '✅ ' + r.msg;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* v2.1.0a：墨墨 Token 自动保存（失焦或粘贴后即保存，无需手动点保存） */
async function saveMaimemoTokenSilent() {
  const val = $('#cfgToken').value.trim();
  if (!val) return;                      // 空值不覆盖已存 Token
  const out = $('#tokenSaveResult');
  try {
    await api('/api/config', { method: 'POST', body: { maimemoToken: val } });
    $('#cfgToken').value = '';
    $('#cfgToken').placeholder = '已保存 ✓（留空 = 沿用）';
    if (out) { out.textContent = '✅ Token 已自动保存'; out.className = 'result ok'; }
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'result err'; }
  }
}
if ($('#cfgToken')) {
  $('#cfgToken').addEventListener('change', saveMaimemoTokenSilent);
  $('#cfgToken').addEventListener('blur', saveMaimemoTokenSilent);
  $('#cfgToken').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveMaimemoTokenSilent(); } });
}

/* v2.1.0a：自动同步配置自动保存（勾选/改间隔即时生效） */
async function saveAutoSyncSilent() {
  try {
    await api('/api/config', {
      method: 'POST',
      body: { autoSync: { enabled: $('#cfgAutoSync').checked, minutes: Number($('#cfgSyncMinutes').value) || 60 } },
    });
  } catch (e) { console.error(e); }
}
if ($('#cfgAutoSync')) $('#cfgAutoSync').addEventListener('change', saveAutoSyncSilent);
if ($('#cfgSyncMinutes')) $('#cfgSyncMinutes').addEventListener('change', saveAutoSyncSilent);

$('#testMaimemoBtn').addEventListener('click', async () => {
  if ($('#cfgToken').value.trim()) await saveMaimemoTokenSilent();
  $('#maimemoTestResult').textContent = '测试中…';
  $('#maimemoTestResult').className = 'result';
  try {
    const r = await api('/api/test/maimemo', { method: 'POST' });
    $('#maimemoTestResult').textContent = '✅ ' + r.msg;
    $('#maimemoTestResult').className = 'result ok';
  } catch (e) {
    $('#maimemoTestResult').textContent = '❌ ' + e.message;
    $('#maimemoTestResult').className = 'result err';
  }
});

$('#syncNowBtn').addEventListener('click', async () => {
  if ($('#cfgToken').value.trim()) await saveMaimemoTokenSilent();
  switchTab('dashboard');
  doSync(false);
});

/* ---------------- 语料库（v2.0.1：手工上传外刊 + 自动发布源 + 真题） ---------------- */

const KB_SECTION_LABEL = {
  use_of_english: '完形填空', reading: '阅读 A', part_b: '新题型',
  translation: '翻译', writing: '写作',
};
const kbState = { records: [], filter: '', loaded: false, page: 1, pageSize: 10, searchResults: null };   // v1.1.2：filter = 来源分类（外刊/教材/真题/直录）；v2.0.0.a 分页

function renderPaginationBar(containerId, currentPage, totalPages, totalCount, onPageChange) {
  const container = $(containerId);
  if (!container) return;
  if (totalPages <= 1) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  let html = '';
  html += `<button class="page-btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>`;
  
  // 生成页码序列（显示第 1 页、当前页前后各 1 页、最后一页，中间省略号）
  const pages = [];
  pages.push(1);
  const left = Math.max(2, currentPage - 1);
  const right = Math.min(totalPages - 1, currentPage + 1);
  if (left > 2) pages.push('...');
  for (let p = left; p <= right; p++) {
    if (!pages.includes(p)) pages.push(p);
  }
  if (right < totalPages - 1) pages.push('...');
  if (totalPages > 1 && !pages.includes(totalPages)) pages.push(totalPages);

  for (const p of pages) {
    if (p === '...') {
      html += `<span class="page-ellipsis">…</span>`;
    } else {
      html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
  }

  html += `<button class="page-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>`;
  html += `<span class="page-info">第 ${currentPage} / ${totalPages} 页（共 ${totalCount} 篇）</span>`;
  container.innerHTML = html;

  container.onclick = e => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    const targetPage = parseInt(btn.dataset.page, 10);
    if (targetPage && targetPage >= 1 && targetPage <= totalPages && targetPage !== currentPage) {
      onPageChange(targetPage);
    }
  };
}

async function loadKb() {
  if (kbState.loaded) return;
  try {
    const r = await api('/api/kb/records');
    kbState.records = r.records || [];
    kbState.loaded = true;
    if (r.external?.count) {
      const release = r.external.manifest?.release_id ? ` · release ${r.external.manifest.release_id}` : '';
      $('#kbListResult').textContent = `外刊发布源 ${r.external.count} 篇${release}`;
      $('#kbListResult').className = 'result';
    }
    if (!r.exists) {
      $('#kbListResult').textContent = '⚠️ 未找到语料库文件：' + r.file + '（把导入工程的 records.jsonl 同步到 corpus/ 即可）';
      $('#kbListResult').className = 'result err';
    }
    renderKbList();
  } catch (e) { console.error(e); }
}

function renderKbList() {
  const box = $('#kbList');
  const list = kbState.records.filter(r => !kbState.filter || (r.source && r.source.category) === kbState.filter);
  const totalCount = list.length;
  const totalPages = Math.ceil(totalCount / kbState.pageSize) || 1;
  if (kbState.page > totalPages) kbState.page = totalPages;
  if (kbState.page < 1) kbState.page = 1;

  if (!list.length) {
    box.innerHTML = '<div class="empty-prov">该类型下暂无记录。可用下方「📥 导入语料」直接导入文件或粘贴文本。</div>';
    renderPaginationBar('#kbPagination', 1, 0, 0, () => {});
    return;
  }

  const startIdx = (kbState.page - 1) * kbState.pageSize;
  const pageList = list.slice(startIdx, startIdx + kbState.pageSize);

    box.innerHTML = pageList.map(r => `
    <div class="kb-item" data-rid="${esc(r.id)}">
      <div class="kb-item-head">
        <span class="badge kb-badge kb-badge-${esc(r.rtype)}">${esc(r.rtypeLabel)}</span>
        ${r.external ? '<span class="badge kb-badge-year">自动发布</span>' : (r.source?.managed === 'manual' && r.source?.category === '外刊' ? '<span class="badge kb-badge-year">用户上传</span>' : '')}
        ${r.year ? `<span class="badge kb-badge-year">${r.year} 年</span>` : ''}
        <b>${esc(r.title)}</b>
      </div>
      <div class="kb-item-meta">${[
        r.questions ? r.questions + ' 题' : '',
        r.itemCount ? r.itemCount + ' 个条目' : '',
        r.source?.publication ? esc(r.source.publication) : '',
        r.source?.parser ? '解析器 ' + esc(r.source.parser) : '',
        r.source?.published_at ? '发布 ' + esc(String(r.source.published_at).slice(0, 10)) : (r.source?.imported_at ? '导入 ' + esc(String(r.source.imported_at).slice(0, 10)) : ''),
      ].filter(Boolean).join(' · ')}</div>
      ${r.preview ? `<div class="kb-item-preview">${esc(r.preview)}…</div>` : ''}
    </div>`).join('');

  box.onclick = e => {
    const item = e.target.closest('.kb-item');
    if (item && item.dataset.rid) openKbRecord(item.dataset.rid);
  };

  renderPaginationBar('#kbPagination', kbState.page, totalPages, totalCount, newPage => {
    kbState.page = newPage;
    renderKbList();
    $('#tab-kb').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/** 〖N〗 锚点渲染：〖N〗…〖/N〗 配对 = 翻译划线句；独立 〖N〗 = 挖空/答题框 */
function kbText(text) {
  let s = allowU(esc(String(text || '')));
  s = s.replace(/〖(\d+)〗([\s\S]*?)〖\/\1〗/g,
    (m, n, inner) => `<span class="kb-underline"><span class="kb-blank-n">${n}</span>${inner.trim()}</span>`);
  s = s.replace(/〖(\d+)〗/g, (m, n) => `<span class="kb-blank">${n}</span>`);
  return s.split(/\n+/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
}

async function openKbRecord(rid) {
  const card = $('#kbDetailCard');
  card.style.display = 'block';
  $('#kbDetail').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const r = await api('/api/kb/record/' + rid);
    const rec = r.record;
    kbDetailState = { prefix: 'kb', id: rid, rec: null };
    kbCloseEditor();
    $('#kbIssuesPanel').innerHTML = '';
    // v2.2.8：给详情根节点打上记录来源标记，供划选精读/三遍训练取真实 sourceRef
    $('#kbDetail').dataset.rid = rid;
    $('#kbDetail').dataset.sourceKind = rec.external ? 'external' : (rec.rtype === 'qa_set' ? 'exam' : 'corpus');
    $('#kbDetail').dataset.year = rec.meta?.year != null ? String(rec.meta.year) : '';
    $('#kbDetail').dataset.section = '';
    $('#kbDetailTitle').textContent = rec.title || rec.id;
    const readonly = rec.source?.managed === 'external' || rec.external;
    $('#kbEditBtn').style.display = readonly ? 'none' : '';
    $('#kbDelBtn').style.display = readonly ? 'none' : '';
    $('#kbHistoryBtn').style.display = readonly ? 'none' : '';
    $('#kbDetailMeta').textContent = [
      rec.rtypeLabel, rec.meta?.year ? rec.meta.year + ' 年' : '',
      rec.meta?.questions ? rec.meta.questions + ' 题' : '',
      rec.external ? '自动外刊发布源' : (rec.source?.managed === 'manual' && rec.source?.category === '外刊' ? '用户上传外刊' : ''),
      rec.source?.publication || '',
      rec.source?.canonical_url || '',
      rec.source ? `${rec.source.file || ''} · ${rec.source.parser || ''} · ${rec.source.published_at ? '发布 ' + String(rec.source.published_at).slice(0, 10) : '导入 ' + String(rec.source.imported_at || '').slice(0, 10)}` : '',
    ].filter(Boolean).join(' · ');

    let html = '';
    const items = rec.items || [];
    if (!items.length && rec.text) {
      html = `<div class="kb-passage">${kbText(rec.text)}</div>`;
    } else {
      let lastSec = null;
      for (const [ix, it] of items.entries()) {
        if (it.section !== lastSec) {
          lastSec = it.section;
          html += `<div class="kb-sec-title">${esc(KB_SECTION_LABEL[it.section] || it.section || '内容')}</div>`;
        }
        if (it.type === 'passage') {
          html += `<div class="kb-passage" data-itemidx="${ix}">${kbText(it.text)}</div>`;
        } else if (it.type === 'writing') {
          html += `<div class="kb-question" data-itemidx="${ix}"><div class="kb-q-head">✍️ 作文题${it.part ? ' · Part ' + esc(it.part) : ''}${it.score ? ' · ' + esc(String(it.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(it.text)}</div></div>`;
        } else {
          const opts = it.options
            ? Object.entries(it.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')
            : '';
          html += `<div class="kb-question" data-itemidx="${ix}"><div class="kb-q-head">第 ${esc(String(it.number ?? '—'))} 题 · ${esc(it.qtype || '客观题')}${it.score != null ? ' · ' + esc(String(it.score)) + ' 分' : ''}${it.answer ? ` · <span class="kb-ans">答案：${esc(it.answer)}</span>` : ''}</div><div class="kb-q-text">${kbText(it.text)}</div>${opts ? `<div class="kb-opts">${opts}</div>` : ''}</div>`;
        }
      }
    }
    $('#kbDetail').innerHTML = html || '<div class="hint">（无条目）</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#kbDetail').innerHTML = '❌ ' + esc(e.message);
  }
}

async function kbDoSearch() {
  const q = $('#kbSearchInput').value.trim();
  const out = $('#kbListResult');
  if (!q) return;
  out.textContent = '搜索中…';
  out.className = 'result';
  try {
    const r = await api('/api/kb/search?q=' + encodeURIComponent(q));
    if (!r.results.length) {
      out.textContent = `「${q}」全库无匹配`;
      out.className = 'result';
      return;
    }
    out.textContent = `✅ 命中 ${r.count} 条语料（点击可跳原文）`;
    out.className = 'result ok';
    $('#kbList').innerHTML = r.results.map(h => `
      <div class="kb-item" data-rid="${esc(h.rid)}">
        <div class="kb-sentence">${esc(h.s)}</div>
        <div class="kb-item-meta">${h.sourceKind === 'exam' ? '考研真题' : h.sourceKind === 'external' ? '外刊真实语境' : '工作台语料'}：${esc(h.title)}${h.publication ? ' · ' + esc(h.publication) : ''}${h.year ? ' · ' + h.year + ' 年' : ''}${h.section ? ' · ' + esc(KB_SECTION_LABEL[h.section] || h.section) : ''}${h.number ? ' · 第 ' + h.number + ' 题' : ''}</div>
      </div>`).join('');
    renderPaginationBar('#kbPagination', 1, 0, 0, () => {});
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

$('#kbSearchBtn').addEventListener('click', kbDoSearch);
$('#kbSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') kbDoSearch(); });
$('#kbBackBtn').addEventListener('click', () => {
  $('#kbDetailCard').style.display = 'none';
  renderKbList();
  $('#kbListResult').textContent = '';
  $('#kbListResult').className = 'result';
});
$$('#kbFilters .chip').forEach(c => c.addEventListener('click', () => {
  kbState.filter = c.dataset.kcat || '';
  kbState.page = 1; // 切换分类重置回第 1 页
  $$('#kbFilters .chip').forEach(x => x.classList.toggle('active', x === c));
  $('#kbSearchInput').value = '';
  renderKbList();
}));

/* ---------------- v1.1.1：语料导入（三层契约：投放 -> 解析 -> 归档/隔离） ---------------- */

function kbFileToB64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('读取失败: ' + f.name));
    r.readAsDataURL(f);
  });
}

async function kbDoImport(kind) {
  const out = $('#kbImportResult');
  const category = $('#kbImportCategory').value;
  const items = [];
  let paste = null;
  if (kind === 'files') {
    for (const f of $('#kbImportFile').files) {
      if (f.size > 30 * 1024 * 1024) {
        out.textContent = `❌ ${f.name} 超过 30MB 上限`;
        out.className = 'result err';
        return;
      }
      items.push({ name: f.name, data64: await kbFileToB64(f) });
    }
    if (!items.length) {
      out.textContent = '⚠️ 请先选择文件';
      out.className = 'result err';
      return;
    }
  } else {
    paste = { title: $('#kbPasteTitle').value, text: $('#kbPasteText').value };
    if (!paste.text.trim()) {
      out.textContent = '⚠️ 请先粘贴文本内容';
      out.className = 'result err';
      return;
    }
  }
  out.textContent = '解析中…（TeX / PDF 需要几秒钟）';
  out.className = 'result';
  try {
    const r = await api('/api/kb/import', { method: 'POST', body: { category, items, paste } });
    const lines = r.results.map(x => x.ok
      ? `✅ ${esc(x.file)} → ${x.records} 条记录（${esc((x.rtypes || []).join('/'))} · 解析器 ${esc(x.parser || '')}）`
      : `⛔ ${esc(x.file)} 已隔离：${esc(x.reason || '')}${x.hint ? '（' + esc(x.hint) + '）' : ''}`);
    out.innerHTML = lines.join('<br>') + `<br>合计：成功 ${r.imported} · 隔离 ${r.quarantined}`;
    out.className = r.quarantined ? 'result err' : 'result ok';
    if (kind === 'files') $('#kbImportFile').value = '';
    else { $('#kbPasteText').value = ''; $('#kbPasteTitle').value = ''; }
    kbState.loaded = false;   // 重新拉取列表（含新记录）
    loadKb();
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

async function kbShowLog(targetId = '#kbImportResult') {
  const out = $(targetId);
  out.textContent = '加载中…';
  out.className = 'result';
  try {
    const r = await api('/api/kb/importlog');
    out.innerHTML = r.log.length
      ? r.log.map(e => {
          const ok = e.status === 'imported';
          const store = e.store ? ` · ${e.store.includes('exam') ? '🗂真题库' : ''}${e.store.includes('corpus') ? '📚语料库' : ''}` : '';
          return `<div>${ok ? '✅' : '⛔'} ${esc(String(e.time || '').slice(0, 19))} · ${esc(e.file || '')} · ${esc(e.category || '')}${esc(store)} · ${ok ? esc(e.parser || '') + ' · ' + e.records + ' 条' : '隔离：' + esc(e.reason || '')}</div>`;
        }).join('')
      : '暂无导入日志（records.jsonl 所在目录下的 import_log.jsonl）';
    out.className = 'result';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

$('#kbImportBtn').addEventListener('click', () => kbDoImport('files'));
$('#kbPasteBtn').addEventListener('click', () => kbDoImport('paste'));
$('#kbLogBtn').addEventListener('click', kbShowLog);

/* ---------------- 真题库（v1.1.2：qa_set 分库 +「考试-题型」专项处理） ---------------- */

const examState = { records: [], loaded: false, page: 1, pageSize: 10 };

const EXAM_TYPE_FALLBACK = {
  use_of_english: '考研-完形填空', reading: '考研-阅读理解', part_b: '考研-新题型',
  translation: '考研-翻译', writing: '考研-写作',
};

/* 「考试-题型」处理器注册表：每个题型一个独立模块，统一契约——
   { icon, analyze(items) -> 统计行, render(items) -> html }
   板块展示名以服务端下发的 label 为准（考试-题型 格式）。 */
const EXAM_PROCESSORS = {
  use_of_english: {
    icon: '🔲',
    analyze(items) {
      const blanks = new Set();
      let qs = 0, opts = 0;
      for (const it of items) {
        if (it.type === 'passage') for (const m of String(it.text || '').matchAll(/〖(\d+)〗/g)) blanks.add(+m[1]);
        if (it.type === 'question') { qs++; if (it.options) opts++; }
      }
      return `挖空 ${blanks.size} 处 · 题目 ${qs} 题 · 带选项 ${opts} 题`;
    },
    render: kbExamPassageAndQuestions,
  },
  reading: {
    icon: '📖',
    analyze(items) {
      const pids = new Set(items.filter(i => i.type === 'passage' && i.passage_id != null).map(i => i.passage_id));
      const qs = items.filter(i => i.type === 'question').length;
      const per = pids.size ? qs / pids.size : 0;
      return `${pids.size || '—'} 篇文章 · ${qs} 题 · 每篇 ${per && Number.isInteger(per) ? per : per ? per.toFixed(1) : '—'} 题`;
    },
    render: kbExamPassageAndQuestions,
  },
  part_b: {
    icon: '🧩',
    analyze(items) {
      const blanks = new Set();
      let pool = 0, qs = 0;
      for (const it of items) {
        if (it.type === 'passage') for (const m of String(it.text || '').matchAll(/〖(4[1-5])〗/g)) blanks.add(+m[1]);
        if (it.type === 'question' && it.number == null && it.options) pool = Object.keys(it.options).length;
        if (it.type === 'question' && it.number != null) qs++;
      }
      return `空位 ${blanks.size} 处 · 选项池 ${pool || '—'} 项 · 待选 ${qs} 空`;
    },
    render(items, base = 0) {
      let html = '';
      for (const [ix, it] of items.entries()) {
        if (it.type === 'passage') {
          html += `<div class="kb-passage" data-itemidx="${base + ix}">${kbText(it.text)}</div>`;
        } else if (it.type === 'question' && it.number == null) {
          const opts = it.options
            ? Object.entries(it.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')
            : esc(it.text || '');
          html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">🧩 选项池（含干扰项）</div><div class="kb-opts">${opts}</div></div>`;
        } else if (it.type === 'question') {
          html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">第 ${esc(String(it.number ?? '—'))} 空 · 从选项池中选出填入</div><div class="exm-slot">答题位（在线作答后续版本开放）</div></div>`;
        }
      }
      return html;
    },
  },
  translation: {
    icon: '🖊',
    analyze(items) {
      const ul = new Set();
      let qs = 0;
      for (const it of items) {
        if (it.type === 'passage') for (const m of String(it.text || '').matchAll(/〖(\d+)〗/g)) ul.add(+m[1]);
        if (it.type === 'question') qs++;
      }
      return `划线句 ${ul.size} 句 · 待译 ${qs} 题（每题 2 分 · 手写译文）`;
    },
    render(items, base = 0) {
      let html = '';
      for (const [ix, it] of items.entries()) {
        if (it.type === 'passage') {
          html += `<div class="kb-passage" data-itemidx="${base + ix}">${kbText(it.text)}</div>`;
        } else {
          html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">🖊 第 ${esc(String(it.number ?? '—'))} 题 · 将划线句译成中文（2 分）</div><div class="exm-slot">答题位（在线作答后续版本开放）</div></div>`;
        }
      }
      return html;
    },
  },
  writing: {
    icon: '📝',
    analyze(items) {
      const ws = items.filter(i => i.type === 'writing');
      const score = ws.reduce((a, b) => a + (Number(b.score) || 0), 0);
      return `${ws.length} 道写作题 · 合计 ${score || '—'} 分`;
    },
    render(items, base = 0) {
      let html = '';
      for (const [ix, it] of items.entries()) {
        if (it.type !== 'writing') continue;
        html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">✍️ 作文题${it.part ? ' · Part ' + esc(it.part) : ''}${it.score ? ' · ' + esc(String(it.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(it.text)}</div></div>`;
      }
      return html;
    },
  },
};

function examProcessor(section) {
  return EXAM_PROCESSORS[section] || {
    icon: '🧩',
    analyze(items) { return `${items.length} 个条目`; },
    render: kbExamPassageAndQuestions,
  };
}

/** 通用题型渲染：原文（〖N〗锚点）在前，题目（题干+选项+答案）在后 */
function kbExamPassageAndQuestions(items, base = 0) {
  let html = '';
  for (const [ix, it] of items.entries()) {
    if (it.type === 'passage') {
      html += `<div class="kb-passage" data-itemidx="${base + ix}">${kbText(it.text)}</div>`;
    } else if (it.type === 'writing') {
      html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">✍️ 作文题${it.part ? ' · Part ' + esc(it.part) : ''}${it.score ? ' · ' + esc(String(it.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(it.text)}</div></div>`;
    } else {
      const opts = it.options
        ? Object.entries(it.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')
        : '';
      html += `<div class="kb-question" data-itemidx="${base + ix}"><div class="kb-q-head">第 ${esc(String(it.number ?? '—'))} 题 · ${esc(it.qtype || '客观题')}${it.score != null ? ' · ' + esc(String(it.score)) + ' 分' : ''}${it.answer ? ` · <span class="kb-ans">答案：${esc(it.answer)}</span>` : ''}</div><div class="kb-q-text">${kbText(it.text)}</div>${opts ? `<div class="kb-opts">${opts}</div>` : ''}</div>`;
    }
  }
  return html;
}

async function loadExamList() {
  if (examState.loaded) return;
  try {
    const r = await api('/api/exam/records');
    examState.records = r.records || [];
    examState.loaded = true;
    if (!r.exists) {
      $('#exListResult').textContent = '⚠️ 未找到真题库文件：' + r.file;
      $('#exListResult').className = 'result err';
    }
    renderExamList();
  } catch (e) { console.error(e); }
}

function renderExamList() {
  const box = $('#exList');
  const totalCount = examState.records.length;
  const totalPages = Math.ceil(totalCount / examState.pageSize) || 1;
  if (examState.page > totalPages) examState.page = totalPages;
  if (examState.page < 1) examState.page = 1;

  if (!examState.records.length) {
    box.innerHTML = '<div class="empty-prov">真题库还是空的。用上方「🗂 导入真题」导入 tex / pdf 真题源。</div>';
    renderPaginationBar('#exPagination', 1, 0, 0, () => {});
    return;
  }

  const startIdx = (examState.page - 1) * examState.pageSize;
  const pageList = examState.records.slice(startIdx, startIdx + examState.pageSize);

  box.innerHTML = pageList.map(r => `
    <div class="kb-item" data-exid="${esc(r.id)}">
      <div class="kb-item-head">
        <span class="badge kb-badge kb-badge-qa_set">${esc(r.rtypeLabel)}</span>
        ${r.year ? `<span class="badge kb-badge-year">${r.year} 年</span>` : ''}
        <b>${esc(r.title)}</b>
      </div>
      <div class="kb-item-meta">${[
        r.questions ? r.questions + ' 题' : '',
        r.source?.parser ? '解析器 ' + esc(r.source.parser) : '',
        r.source?.imported_at ? '导入 ' + esc(String(r.source.imported_at).slice(0, 10)) : '',
      ].filter(Boolean).join(' · ')}</div>
      ${(r.sections || []).length ? `<div class="exm-chips">${r.sections.map(s => `<span class="chip exm-chip">${esc(s.label)} ${s.questions || s.writings || s.passages || ''}</span>`).join('')}</div>` : ''}
      ${r.preview ? `<div class="kb-item-preview">${esc(r.preview)}…</div>` : ''}
    </div>`).join('');

  box.onclick = e => {
    const item = e.target.closest('.kb-item');
    if (item && item.dataset.exid) openExamRecord(item.dataset.exid);
  };

  renderPaginationBar('#exPagination', examState.page, totalPages, totalCount, newPage => {
    examState.page = newPage;
    renderExamList();
    $('#tab-exam').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function openExamRecord(exid) {
  const card = $('#exDetailCard');
  card.style.display = 'block';
  $('#exDetail').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const r = await api('/api/exam/record/' + exid);
    const rec = r.record;
    kbDetailState = { prefix: 'ex', id: exid, rec: null };
    kbCloseEditor();
    $('#exIssuesPanel').innerHTML = '';
    $('#exEditBtn').style.display = '';
    $('#exDelBtn').style.display = '';
    $('#exHistoryBtn').style.display = '';
    // v2.2.8：详情根节点标记真题来源，供划选取真实 sourceRef
    $('#exDetail').dataset.rid = exid;
    $('#exDetail').dataset.sourceKind = 'exam';
    $('#exDetail').dataset.year = rec.meta?.year != null ? String(rec.meta.year) : '';
    $('#exDetail').dataset.section = '';
    $('#exDetailTitle').textContent = rec.title || rec.id;
    $('#exDetailMeta').textContent = [
      rec.rtypeLabel, rec.meta?.year ? rec.meta.year + ' 年' : '',
      rec.meta?.questions ? rec.meta.questions + ' 题' : '',
      rec.source ? `${rec.source.file || ''} · ${rec.source.parser || ''} · 导入 ${String(rec.source.imported_at || '').slice(0, 10)}` : '',
    ].filter(Boolean).join(' · ');

    // 按「考试-题型」分块：每块交给独立处理器（统一 analyze + render 契约）
    const blocks = [];
    for (const it of (rec.items || [])) {
      const s = it.section || 'misc';
      if (!blocks.length || blocks[blocks.length - 1].key !== s) {
        const label = (rec.sections || []).find(x => x.key === s)?.label
          || EXAM_TYPE_FALLBACK[s] || ('考研-' + (s === 'misc' ? '其他' : s));
        blocks.push({ key: s, label, items: [] });
      }
      blocks[blocks.length - 1].items.push(it);
    }
    let html = '';
    let ixBase = 0;
    for (const b of blocks) {
      const proc = examProcessor(b.key);
      html += `<div class="exm-block"><div class="kb-sec-title">${proc.icon} ${esc(b.label)}</div><div class="exm-stats">${esc(proc.analyze(b.items))}</div>${proc.render(b.items, ixBase)}</div>`;
      ixBase += b.items.length;
    }
    $('#exDetail').innerHTML = html || '<div class="hint">（无条目）</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#exDetail').innerHTML = '❌ ' + esc(e.message);
  }
}

async function exDoImport() {
  const out = $('#exImportResult');
  const files = [...$('#exImportFile').files];
  if (!files.length) {
    out.textContent = '⚠️ 请先选择 tex / pdf 文件';
    out.className = 'result err';
    return;
  }
  const items = [];
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) {
      out.textContent = `❌ ${f.name} 超过 30MB 上限`;
      out.className = 'result err';
      return;
    }
    items.push({ name: f.name, data64: await kbFileToB64(f) });
  }
  out.textContent = '拆题解析中…（TeX 秒级，PDF 视大小而定）';
  out.className = 'result';
  try {
    const r = await api('/api/exam/import', { method: 'POST', body: { items } });
    const lines = r.results.map(x => x.ok
      ? `✅ ${esc(x.file)} → ${x.records} 条记录（${esc((x.rtypes || []).join('/'))} · 解析器 ${esc(x.parser || '')}${x.store && x.store.includes('corpus') ? ' · 拆题未达阈值，整卷落入语料库（真题正文）' : ''}）`
      : `⛔ ${esc(x.file)} 已隔离：${esc(x.reason || '')}${x.hint ? '（' + esc(x.hint) + '）' : ''}`);
    out.innerHTML = lines.join('<br>') + `<br>合计：成功 ${r.imported} · 隔离 ${r.quarantined}`;
    out.className = r.quarantined ? 'result err' : 'result ok';
    $('#exImportFile').value = '';
    examState.loaded = false;   // 重新拉取真题列表
    loadExamList();
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
}

$('#exImportBtn').addEventListener('click', exDoImport);
$('#exLogBtn').addEventListener('click', () => kbShowLog('#exImportResult'));
$('#exBackBtn').addEventListener('click', () => {
  $('#exDetailCard').style.display = 'none';
  renderExamList();
  $('#exListResult').textContent = '';
  $('#exListResult').className = 'result';
});

/* ---------------- v1.1.5：单元题库（整卷切片 + 分题型做题规则；v2.1.0 分页） ---------------- */

const unitState = { units: [], loaded: false, filter: '', page: 1, pageSize: 10 };
const UNIT_SEC_LABEL = { use_of_english: '完形填空', reading: '阅读理解', part_b: '新题型', translation: '翻译', writing: '写作' };

async function loadUnits() {
  if (unitState.loaded) return;
  try {
    const r = await api('/api/unit/records');
    unitState.units = r.units || [];
    unitState.loaded = true;
    renderUnitList();
  } catch (e) { console.error(e); }
}

function renderUnitList() {
  const box = $('#unitList');
  const list = unitState.units.filter(u => !unitState.filter || u.section === unitState.filter);
  const totalCount = list.length;
  const totalPages = Math.ceil(totalCount / unitState.pageSize) || 1;
  if (unitState.page > totalPages) unitState.page = totalPages;
  if (unitState.page < 1) unitState.page = 1;

  if (!list.length) {
    box.innerHTML = '<div class="empty-prov">还没有单元。到「🗂 真题库」导入 tex / 文字层 PDF，拆题成功后单元自动生成。</div>';
    renderPaginationBar('#unitPagination', 1, 0, 0, () => {});
    return;
  }

  const startIdx = (unitState.page - 1) * unitState.pageSize;
  const pageList = list.slice(startIdx, startIdx + unitState.pageSize);

  box.innerHTML = pageList.map(u => `
    <div class="kb-item" data-uid="${esc(u.unitId)}">
      <div class="kb-item-head">
        <span class="badge kb-badge kb-badge-qa_set">${esc(u.label)}</span>
        ${u.year ? `<span class="badge kb-badge-year">${u.year} 年</span>` : ''}
        <b>${esc(u.title)}</b>
        ${u.hasAnswer ? '<span class="badge kb-badge-year">有答案</span>' : ''}
      </div>
      <div class="kb-item-meta">${[u.qCount ? u.qCount + ' 题' : '', u.itemCount + ' 个条目', u.scored ? '可判分' : '主观题'].filter(Boolean).join(' · ')}</div>
      ${u.preview ? `<div class="kb-item-preview">${esc(u.preview)}…</div>` : ''}
    </div>`).join('');

  box.onclick = e => {
    const item = e.target.closest('.kb-item');
    if (item && item.dataset.uid) openUnit(item.dataset.uid);
  };

  renderPaginationBar('#unitPagination', unitState.page, totalPages, totalCount, newPage => {
    unitState.page = newPage;
    renderUnitList();
    $('#tab-unit').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

$$('#unitFilters .chip').forEach(c => c.addEventListener('click', () => {
  unitState.filter = c.dataset.usec || '';
  unitState.page = 1; // 切换分类重置回第 1 页
  $$('#unitFilters .chip').forEach(x => x.classList.toggle('active', x === c));
  renderUnitList();
}));

$('#unitBackBtn').addEventListener('click', () => {
  $('#unitDetailCard').style.display = 'none';
  renderUnitList();
});

/* 分题型生题规则：把单元条目渲染成真实做题形态（完形=挖空内联选词 / 阅读=逐题单选 /
   新题型=空位+选项池 / 翻译=划线句+译文框 / 写作=题干+作文框） */
function unitPracticeHtml(unit, items) {
  const passage = items.find(it => it.type === 'passage');
  const writings = items.filter(it => it.type === 'writing');
  const qs = items.filter(it => it.type === 'question');

  if (unit.section === 'use_of_english' && passage) {
    const qByNum = {};
    qs.forEach(q => { qByNum[q.number] = q; });
    let s = allowU(esc(passage.text || '')).replace(/〖\/\d+〗/g, '');
    s = s.replace(/〖(\d+)〗/g, (m, n) => {
      const q = qByNum[Number(n)];
      const opts = q && q.options
        ? Object.entries(q.options).map(([k, v]) => `<option value="${esc(k)}">${esc(k)}. ${esc(String(v).slice(0, 42))}</option>`).join('')
        : '';
      return `<span class="u-blank"><b>${n}</b><select class="input u-pick" data-num="${n}"><option value="">—</option>${opts}</select></span>`;
    });
    const html = s.split(/\n+/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
    const confRow = qs.length ? `
      <div class="u-conf-panel">
        <div class="u-conf-panel-title">完形作答信心评估（默认犹豫）</div>
        <div class="u-conf-grid">
          ${qs.map(q => `
            <div class="unit-conf-item" data-qnum="${q.number}">
              <span class="unit-conf-num">第 ${q.number} 题</span>
              <div class="unit-conf-group" data-qnum="${q.number}">
                <button type="button" class="btn mini unit-conf-btn" data-conf="sure">🎯</button>
                <button type="button" class="btn mini unit-conf-btn active" data-conf="unsure">🤔</button>
                <button type="button" class="btn mini unit-conf-btn" data-conf="guess">🎲</button>
              </div>
            </div>`).join('')}
        </div>
      </div>` : '';
    return { body: `<div class="kb-passage">${html}</div>${confRow}` };
  }
  if (unit.section === 'part_b' && passage) {
    const src = qs.find(q => q.options);
    const optKeys = src ? Object.keys(src.options) : 'ABCDEFG'.split('');
    let s = allowU(esc(passage.text || '')).replace(/〖\/\d+〗/g, '');
    s = s.replace(/〖(\d+)〗/g, (m, n) =>
      `<span class="u-gap"><b>${n}</b><select class="input u-pick" data-num="${n}"><option value="">—</option>${optKeys.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select></span>`);
    const html = s.split(/\n+/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
    const poolHtml = src ? `<div class="kb-sec-title">选项池</div><div class="kb-opts">${Object.entries(src.options).map(([k, v]) => `<span class="kb-opt"><b>${esc(k)}.</b> ${esc(v)}</span>`).join('')}</div>` : '';
    const confRow = qs.length ? `
      <div class="u-conf-panel">
        <div class="u-conf-panel-title">新题型作答信心评估（默认犹豫）</div>
        <div class="u-conf-grid">
          ${qs.map(q => `
            <div class="unit-conf-item" data-qnum="${q.number}">
              <span class="unit-conf-num">第 ${q.number} 题</span>
              <div class="unit-conf-group" data-qnum="${q.number}">
                <button type="button" class="btn mini unit-conf-btn" data-conf="sure">🎯</button>
                <button type="button" class="btn mini unit-conf-btn active" data-conf="unsure">🤔</button>
                <button type="button" class="btn mini unit-conf-btn" data-conf="guess">🎲</button>
              </div>
            </div>`).join('')}
        </div>
      </div>` : '';
    return { body: `<div class="kb-passage">${html}</div>${poolHtml}${confRow}` };
  }
  if (unit.section === 'reading') {
    let html = passage ? `<div class="kb-passage">${kbText(passage.text)}</div>` : '';
    html += qs.map(q => {
      const qNum = esc(String(q.number ?? '—'));
      const opts = q.options ? Object.entries(q.options).map(([k, v]) =>
        `<label class="u-opt"><input type="radio" name="q${qNum}" value="${esc(k)}" data-num="${qNum}"><b>${esc(k)}.</b> ${esc(v)}</label>`).join('')
        : '';
      return `
        <div class="kb-question" data-qnum="${qNum}">
          <div class="kb-q-head-row">
            <div class="kb-q-head">第 ${qNum} 题</div>
            <div class="unit-conf-group" data-qnum="${qNum}">
              <span class="unit-conf-label">信心:</span>
              <button type="button" class="btn mini unit-conf-btn" data-conf="sure">🎯确定</button>
              <button type="button" class="btn mini unit-conf-btn active" data-conf="unsure">🤔犹豫</button>
              <button type="button" class="btn mini unit-conf-btn" data-conf="guess">🎲猜测</button>
            </div>
          </div>
          <div class="kb-q-text">${kbText(q.text)}</div>
          <div class="u-opts">${opts}</div>
        </div>`;
    }).join('');
    return { body: html };
  }
  if (unit.section === 'translation') {
    let html = passage ? `<div class="kb-passage">${kbText(passage.text)}</div>` : '';
    html += qs.map(q => `<div class="kb-question"><div class="kb-q-head">第 ${esc(String(q.number ?? '—'))} 题 · 将划线句译成中文</div><textarea class="input u-trans" data-num="${esc(String(q.number ?? ''))}" rows="3" placeholder="写下你的译文…"></textarea></div>`).join('');
    return { body: html };
  }
  if (unit.section === 'writing') {
    const w = writings[0] || items[0] || {};
    return { body: `<div class="kb-question"><div class="kb-q-head">✍️ ${esc(w.part ? 'Part ' + w.part : '作文')}${w.score ? ' · ' + esc(String(w.score)) + ' 分' : ''}</div><div class="kb-q-text">${kbText(w.text || '')}</div><textarea class="input u-essay" rows="12" placeholder="在纸上写完再对照解析，或直接在此打草稿…"></textarea></div>` };
  }
  return { body: items.map(it => `<div class="kb-passage">${kbText(it.text)}</div>`).join('') };
}

async function openUnit(uid) {
  const card = $('#unitDetailCard');
  card.style.display = 'block';
  $('#unitDetail').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const r = await api('/api/unit/detail/' + encodeURIComponent(uid));
    const unit = r.unit, items = r.items, answerState = r.answerState;
    // v2.2.8：单元详情根节点标记真题来源（rid=examId）与题型/年份，供划选取真实 sourceRef
    $('#unitDetail').dataset.rid = unit.examId || '';
    $('#unitDetail').dataset.sourceKind = 'exam';
    $('#unitDetail').dataset.year = unit.year != null ? String(unit.year) : '';
    $('#unitDetail').dataset.section = unit.section || '';
    $('#unitDetailTitle').textContent = unit.title;
    $('#unitDetailMeta').textContent = [
      unit.label, unit.year ? unit.year + ' 年' : '',
      unit.qCount + ' 题',
      answerState.has ? '已录标准答案（' + answerState.keys.length + ' 题）' : '未录标准答案',
    ].filter(Boolean).join(' · ');

    const { body } = unitPracticeHtml(unit, items);
    $('#unitDetail').innerHTML = body + `
      <div class="row-gap" style="margin-top:14px">
        <button class="btn primary" id="unitSubmitBtn">✅ 提交答案</button>
        <button class="btn" id="unitAnswerBtn">📝 录入标准答案</button>
        <button class="btn ghost" id="unitBackBtn2">← 返回列表</button>
      </div>
      <div class="result" id="unitResult"></div>
      <div id="unitAnswerPanel" style="display:none"></div>`;

    const unitStartedAt = new Date().toISOString();

    // 绑定信心按钮切换事件
    $$('#unitDetail .unit-conf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.unit-conf-group');
        if (group) {
          group.querySelectorAll('.unit-conf-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        }
      });
    });

    $('#unitBackBtn2').addEventListener('click', () => {
      card.style.display = 'none';
      renderUnitList();
    });

    $('#unitSubmitBtn').addEventListener('click', async () => {
      const answers = {};
      const confidence = {};
      const subjective = { translations: {}, essay: '' };

      // v2.2.8：按单元题型只收集对应 section 的作答，避免跨 section 字段被服务端拒绝
      const unitSection = unit.section || 'misc';
      const isObjective = unitSection !== 'translation' && unitSection !== 'writing';

      // 1. 客观题作答与信心收集（仅客观题单元）
      if (isObjective) {
        $$('#unitDetail .u-pick').forEach(s => {
          if (s.value) answers[s.dataset.num] = s.value;
        });
        $$('#unitDetail .u-opt input:checked').forEach(r2 => {
          answers[r2.dataset.num] = r2.value;
        });
        $$('#unitDetail .unit-conf-group').forEach(group => {
          const qnum = group.dataset.qnum;
          const activeBtn = group.querySelector('.unit-conf-btn.active');
          if (qnum && activeBtn) {
            confidence[qnum] = activeBtn.dataset.conf || 'unsure';
          }
        });
      }

      // 2. 主观题收集：翻译（仅翻译单元）
      if (unitSection === 'translation') {
        $$('#unitDetail .u-trans').forEach(t => {
          const val = t.value.trim();
          if (val) subjective.translations[t.dataset.num] = val;
        });
      }

      // 3. 主观题收集：写作（仅写作单元）
      if (unitSection === 'writing') {
        const essayEl = $('#unitDetail .u-essay');
        if (essayEl) {
          const rawEssay = essayEl.value.trim();
          if (rawEssay) {
            if (rawEssay.length > 4000) {
              const out = $('#unitResult');
              out.textContent = '❌ 作文字数超过 4000 字符限制，请精简后再提交';
              out.className = 'result err';
              return;
            }
            subjective.essay = rawEssay;
          }
        }
      }

      const out = $('#unitResult');
      out.textContent = '判分与提交中…';
      out.className = 'result';

      // v2.2.8：本批次唯一 batchId，用于关联作答与错因权限
      const batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      try {
        const r2 = await api('/api/unit/answers/submit', {
          method: 'POST',
          body: {
            unitId: uid,
            batchId,
            answers,
            confidence,
            subjective,
            startedAt: unitStartedAt,
          },
        });

        // 格式化判分结果
        const lines = (r2.results || []).map(x => {
          if (x.ok === null) {
            return x.picked ? `<div class="u-item-res">· 第 ${esc(String(x.number))} 题：作答已记录（无标准答案，不判分）</div>` : '';
          }
          if (x.ok) {
            return `<div class="u-item-res u-ok">✓ 第 ${esc(String(x.number))} 题：正确（你的选项: ${esc(x.picked)}）</div>`;
          }
          // 错题：显示标准答案，并提供固定错因标签选择
          const reasons = [
            { key: 'unknown_word', label: '生词障碍' },
            { key: 'misread_stem', label: '看错题干' },
            { key: 'evidence_missed', label: '定位遗漏' },
            { key: 'over_inference', label: '过度推断' },
            { key: 'option_trap', label: '选项陷阱' },
            { key: 'careless', label: '粗心手滑' },
            { key: 'time_pressure', label: '时间紧张' },
            { key: 'other', label: '其他原因' },
          ];
          const reasonBtns = reasons.map(r =>
            `<button type="button" class="btn mini u-reason-btn" data-att="${esc(x.attemptId)}" data-batch="${esc(r2.batchId || batchId)}" data-reason="${esc(r.key)}">${esc(r.label)}</button>`
          ).join('');

          return `
            <div class="u-item-res u-bad" data-att="${esc(x.attemptId)}">
              <div>✗ 第 ${esc(String(x.number))} 题：错误 · 正确答案 <b>${esc(x.correct || '')}</b> · 你选了 <b>${esc(x.picked || '')}</b></div>
              <div class="u-reason-row">
                <span class="u-reason-tip">标记错因:</span>
                ${reasonBtns}
                <span class="u-reason-feedback" id="rf_${esc(x.attemptId)}"></span>
              </div>
            </div>`;
        });

        let subjectiveSummary = '';
        if (r2.subjective > 0) {
          subjectiveSummary = `<div class="u-subj-note">📝 已保存 ${r2.subjective} 项主观题作答（译文/草稿、字数与耗时已记录，不作自动估分）</div>`;
        }

        const headSummary = r2.hasStd
          ? `<b>客观题：${r2.correct}/${r2.judged} 正确</b>`
          : (r2.judged > 0 ? '该单元尚未录入标准答案——点「📝 录入标准答案」后即可判分（作答已记录）' : '');

        out.innerHTML = (headSummary ? headSummary + '<br>' : '') + subjectiveSummary + lines.filter(Boolean).join('');
        out.className = (r2.hasStd && r2.judged && r2.correct === r2.judged) ? 'result ok' : 'result';

        // 绑定错因后补点击事件
        $$('#unitResult .u-reason-btn').forEach(b => {
          b.addEventListener('click', async () => {
            const attId = b.dataset.att;
            const rKey = b.dataset.reason;
            const batch = b.dataset.batch;
            const pRow = b.closest('.u-reason-row');
            if (pRow) {
              pRow.querySelectorAll('.u-reason-btn').forEach(btn => btn.classList.remove('active'));
              b.classList.add('active');
            }
            try {
              await api('/api/unit/answers/submit', {
                method: 'POST',
                body: { unitId: uid, batchId: batch, reasonOnly: true, attemptId: attId, errorReason: rKey }
              });
              const fb = $('#rf_' + attId);
              if (fb) fb.textContent = '✓ 错因已更新';
            } catch (err) {
              const fb = $('#rf_' + attId);
              if (fb) fb.textContent = '❌ ' + err.message;
            }
          });
        });

      } catch (e) {
        out.textContent = '❌ ' + e.message;
        out.className = 'result err';
      }
    });

    $('#unitAnswerBtn').addEventListener('click', () => {
      const panel = $('#unitAnswerPanel');
      if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
      const qws = (() => {
        const pool = items.find(it => it.type === 'question' && it.options && Object.keys(it.options).length);
        const keysFor = q => (q.options && Object.keys(q.options).length) ? Object.keys(q.options)
          : (unit.section === 'part_b' && pool ? Object.keys(pool.options) : []);
        return items.filter(it => it.type === 'question' && it.number != null && keysFor(it).length);
      })();
      if (!qws.length) { panel.innerHTML = '<div class="hint">该单元没有可判分的客观题。</div>'; panel.style.display = 'block'; return; }
      const pool = items.find(it => it.type === 'question' && it.options && Object.keys(it.options).length);
      const keysFor = q => (q.options && Object.keys(q.options).length) ? Object.keys(q.options)
        : (unit.section === 'part_b' && pool ? Object.keys(pool.options) : []);
      panel.innerHTML = `<div class="card-title" style="margin-top:10px">📝 录入标准答案（请用权威版答案人工录入；标准答案不影响本机数据，仅存 data/answers.json）</div>
        <div class="u-ans-grid">${qws.map(q => {
          const keys = keysFor(q);
          return `<span class="u-ans-item">第 ${esc(String(q.number))} 题 <select class="input u-std" data-num="${esc(String(q.number))}"><option value="">—</option>${keys.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select>${answerState.keys.includes(String(q.number)) ? '<span class="u-ok">已有</span>' : ''}</span>`;
        }).join('')}</div>
        <div class="row-gap" style="margin-top:8px"><button class="btn primary" id="unitAnsSave">💾 保存答案</button></div>
        <div class="result" id="unitAnsResult"></div>`;
      panel.style.display = 'block';
      $('#unitAnsSave').addEventListener('click', async () => {
        const answers = {};
        $$('#unitAnswerPanel .u-std').forEach(s => { if (s.value) answers[s.dataset.num] = s.value; });
        const out = $('#unitAnsResult');
        try {
          const r2 = await api('/api/unit/answers/save', { method: 'POST', body: { unitId: uid, answers } });
          out.textContent = '✅ 已保存 ' + r2.saved + ' 条标准答案';
          out.className = 'result ok';
          unitState.loaded = false;
        } catch (e) {
          out.textContent = '❌ ' + e.message;
          out.className = 'result err';
        }
      });
    });

    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#unitDetail').innerHTML = '❌ ' + esc(e.message);
  }
}

/* ---------------- v1.1.4：MinerU 云端解析 + 记录编辑/删除/AI 审读 ---------------- */

let kbDetailState = { prefix: 'kb', id: null, rec: null };

function kbCloseEditor() {
  ['kb', 'ex'].forEach(px => {
    const p = $('#' + px + 'EditPanel');
    if (p) { p.style.display = 'none'; p.innerHTML = ''; }
  });
  kbDetailState.rec = null;
}

function buildMineruBody() {
  return { mineru: { apiKey: $('#cfgMineruKey').value.trim() || undefined } };   // 留空沿用
}

$('#saveMineruBtn').addEventListener('click', async () => {
  const out = $('#mineruTestResult');
  try {
    await api('/api/config', { method: 'POST', body: buildMineruBody() });
    $('#cfgMineruKey').value = '';
    out.textContent = '✅ 已保存';
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

$('#testMineruBtn').addEventListener('click', async () => {
  const out = $('#mineruTestResult');
  try { await api('/api/config', { method: 'POST', body: buildMineruBody() }); $('#cfgMineruKey').value = ''; }
  catch { /* 测试时如实暴露错误 */ }
  out.textContent = '🛰 MinerU 连接测试中…';
  out.className = 'result';
  try {
    const r = await api('/api/test/mineru', { method: 'POST' });
    out.textContent = '✅ ' + r.msg;
    out.className = 'result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'result err';
  }
});

/* MinerU 云端导入：逐文件上传（云端解析约 1-2 分钟/文件），产出文本记录入库 */
async function mineruDoImport(store) {
  const isExam = store === 'exam';
  const out = isExam ? $('#exImportResult') : $('#kbImportResult');
  const fileInput = isExam ? $('#exMineruFile') : $('#kbMineruFile');
  const ocr = isExam ? $('#exMineruOcr').checked : $('#kbMineruOcr').checked;
  const category = isExam ? '真题' : $('#kbImportCategory').value;
  const files = [...fileInput.files];
  if (!files.length) {
    out.textContent = '⚠️ 请先选择 PDF 文件';
    out.className = 'result err';
    return;
  }
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) {
      out.textContent = `❌ ${esc(f.name)} 超过 30MB 上限`;
      out.className = 'result err';
      return;
    }
  }
  const lines = [];
  out.className = 'result';
  for (const f of files) {
    out.textContent = `🛰 ${f.name} 已提交 MinerU 云端解析…（约 1-2 分钟/文件，请勿关闭页面）`;
    try {
      const r = await api('/api/mineru/parse', { method: 'POST', body: { items: [{ name: f.name, data64: await kbFileToB64(f) }], ocr, category, store } });
      lines.push(r.ok
        ? `✅ ${esc(f.name)} → ${r.records} 条记录（${esc((r.rtypes || []).join('/'))} · MinerU 云端解析）`
        : `⛔ ${esc(f.name)}：${esc(r.reason || '解析失败')}`);
    } catch (e) {
      lines.push(`⛔ ${esc(f.name)}：${esc(e.message)}`);
    }
  }
  out.innerHTML = lines.join('<br>');
  out.className = 'result ok';
  fileInput.value = '';
  if (isExam) { examState.loaded = false; loadExamList(); }
  else { kbState.loaded = false; loadKb(); }
}

$('#kbMineruBtn').addEventListener('click', () => mineruDoImport('corpus'));
$('#exMineruBtn').addEventListener('click', () => mineruDoImport('exam'));

/* 记录编辑：编辑面板基于 ?raw=1 的原始条目顺序；删条目/改文字在内存标记，保存时一次性提交 */
async function kbToggleEditor() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  const panel = $('#' + prefix + 'EditPanel');
  if (panel.style.display === 'block') { kbCloseEditor(); return; }
  panel.innerHTML = '<div class="hint">加载原始记录…</div>';
  panel.style.display = 'block';
  try {
    const r = await api('/api/kb/record/' + id + '?raw=1');
    kbDetailState.rec = r.record;
    kbRenderEditor(prefix, r.record);
  } catch (e) {
    panel.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
  }
}

function kbRenderEditor(prefix, rec) {
  const panel = $('#' + prefix + 'EditPanel');
  const items = rec.items || [];
  const rows = items.map((it, i) => `
    <div class="kb-edit-item">
      <div class="kb-edit-head"><b>#${i + 1}</b><span>${esc(it.type || '')}${it.section ? ' · ' + esc(KB_SECTION_LABEL[it.section] || it.section) : ''}${it.number != null ? ' · 第 ' + esc(String(it.number)) + ' 题' : ''}</span>
        <button class="btn ghost" style="padding:2px 10px;font-size:12px" data-del="${i}">✕ 删此条</button></div>
      <textarea class="input kb-item-text" data-i="${i}" rows="${Math.min(10, Math.max(3, Math.ceil(((it.text || '').length) / 90)))}">${esc(it.text || '')}</textarea>
    </div>`).join('');
  panel.innerHTML = `
    <label class="field-label">标题</label>
    <input type="text" class="input" id="${prefix}EditTitle" value="${esc(rec.title || '')}">
    ${items.length
      ? `<label class="field-label" style="margin-top:8px">条目（${items.length} 条 · 改文字或删条目，保存后生效）</label><div>${rows}</div>`
      : `<label class="field-label" style="margin-top:8px">正文</label><textarea class="input" id="${prefix}EditText" rows="10">${esc(rec.text || '')}</textarea>`}
    <div class="row-gap" style="margin-top:10px">
      <button class="btn primary" id="${prefix}EditSave">💾 保存修改</button>
      <button class="btn ghost" id="${prefix}EditCancel">取消编辑</button>
    </div>
    <div class="result" id="${prefix}EditResult"></div>`;
  $$('#' + prefix + 'EditPanel .kb-item-text').forEach(t =>
    t.addEventListener('input', () => { items[+t.dataset.i]._newText = t.value; }));
  $$('#' + prefix + 'EditPanel [data-del]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.del;
    items[i]._del = !items[i]._del;
    b.textContent = items[i]._del ? '↩ 恢复' : '✕ 删此条';
    b.closest('.kb-edit-item').style.opacity = items[i]._del ? '.45' : '';
  }));
  $('#' + prefix + 'EditCancel').addEventListener('click', kbCloseEditor);
  $('#' + prefix + 'EditSave').addEventListener('click', async () => {
    const out = $('#' + prefix + 'EditResult');
    const body = { id: kbDetailState.id, title: $('#' + prefix + 'EditTitle').value };
    if (items.length) {
      body.items = items.filter(it => !it._del).map(it => {
        const o = {};
        for (const k of ['type', 'section', 'number', 'passage_id', 'options', 'qtype', 'score', 'part', 'answer']) {
          if (it[k] !== undefined && it[k] !== null) o[k] = it[k];
        }
        o.text = it._newText !== undefined ? it._newText : (it.text || '');
        return o;
      });
    } else {
      body.text = $('#' + prefix + 'EditText').value;
    }
    out.textContent = '保存中…';
    out.className = 'result';
    try {
      const r = await api('/api/kb/record/update', { method: 'POST', body });
      out.textContent = '✅ 已保存（' + esc(r.title) + '）';
      out.className = 'result ok';
      kbCloseEditor();
      if (prefix === 'kb') { kbState.loaded = false; loadKb(); openKbRecord(kbDetailState.id); }
      else { examState.loaded = false; loadExamList(); openExamRecord(kbDetailState.id); }
    } catch (e) {
      out.textContent = '❌ ' + e.message;
      out.className = 'result err';
    }
  });
}

/* 记录删除：确认框 + 写导入日志（解析原件仍在 archive/，可重导恢复） */
async function kbDeleteCurrent() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  if (!confirm('确定删除这条记录吗？\n（解析原件仍保留在 archive/，可重新导入恢复；删除会写入导入日志）')) return;
  try {
    const r = await api('/api/kb/record/delete', { method: 'POST', body: { id } });
    alert('已删除：' + r.title);
    kbCloseEditor();
    $('#' + (prefix === 'kb' ? 'kbDetailCard' : 'exDetailCard')).style.display = 'none';
    if (prefix === 'kb') { kbState.loaded = false; loadKb(); }
    else { examState.loaded = false; loadExamList(); }
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

/* AI 审读：LLM 找解析疑点，只出清单不改数据（建议者，不是提交者）。
   v1.1.6：审核对象 = 整理后题库内容（与页面一致）+ 真题原件参考；疑点带 quote 逐字摘录与
   服务端定位（itemIdx/itemTag/itemText），「📍 定位到此」滚动高亮题库对应条目。 */
async function kbDoReview() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  const out = $('#' + prefix + 'IssuesPanel');
  out.innerHTML = '<div class="hint kb-busy">AI 审读中…（报告生成后本行自动消失）</div>';
  try {
    const r = await api('/api/kb/review', { method: 'POST', body: { id } });
    const cls = { high: 'kb-issue-high', mid: 'kb-issue-mid', low: 'kb-issue-low' };
    const located = r.issues.filter(x => x.itemIdx != null).length;
    const modelTag = r.modelUsed ? (r.modelUsed.model ? ` · ${esc(r.modelUsed.model)}` : '') : '';
    const head = `<div class="card-title" style="margin-top:10px">🤖 AI 审读报告 · ${esc(String(r.reviewed_at).replace('T', ' '))}${r.mock ? ' · mock' : ''}${r.readOnly ? ' · 外刊只读' : ''}${modelTag}</div>` +
      (r.materialStats ? `<details class="hint-fold" style="margin:4px 0 0"><summary>📊 审核范围 · 定位成功 ${located}/${r.issues.length}</summary><div class="hint">审核对象：整理后${r.readOnly ? '外刊语料' : '题库'}内容 ${r.materialStats.items} 个条目 / ${r.materialStats.chars} 字符${r.materialStats.truncated ? '，<b>超长已截断</b>' : ''}${r.materialStats.hasRef ? ' + 真题原件参考' : ''}。</div></details>` : '');
    /* v1.1.7e：按题型板块分组汇总（完形/阅读/翻译…），便于集中修改同一板块 */
    const secOf = x => {
      const m = String(x.itemTag || '').match(/^[a-z_]+·([a-z_]+)/);
      return m ? m[1] : (x.itemIdx != null ? 'misc' : 'unlocated');
    };
    const GROUP_ICON = { use_of_english: '🔲 完形填空', reading: '📖 阅读理解', part_b: '🧩 新题型', translation: '🖊 翻译', writing: '📝 写作', misc: '📌 其他条目', unlocated: '🔍 未定位疑点' };
    const groups = [];
    const bySec = new Map();
    r.issues.forEach((x, i) => {
      const s = secOf(x);
      if (!bySec.has(s)) { const g = { sec: s, idxs: [] }; bySec.set(s, g); groups.push(g); }
      bySec.get(s).idxs.push(i);
    });
    const cardHtml = (x, i) => `
        <div class="kb-issue ${cls[x.severity] || 'kb-issue-mid'}" data-issue="${i}">
          <div class="kb-issue-head"><b>${esc(x.loc)}</b>${x.itemTag ? `<span>· ${esc(x.itemTag)}</span>` : ''}<span>· ${esc(x.severity)}</span>${x.itemIdx != null && !r.readOnly ? `<button class="btn ghost" style="padding:2px 10px;font-size:12px;margin-left:auto" data-locate="${i}">📍 定位到此</button>` : ''}</div>
          <div>${esc(x.desc)}</div>
          ${x.quote ? `<div class="kb-issue-quote">“${esc(x.quote)}”</div>` : ''}
          ${!r.readOnly && x.quote ? `
          <div class="kb-issue-fixzone" data-fixzone="${i}">
            ${x.fix ? `<div class="kb-issue-fix"><span class="kb-fix-label">🛠 AI 修正方案</span><div class="kb-fix-new">${esc(x.fix)}</div></div>` : `<div class="hint" style="margin:6px 0 0">（AI 未给出可直接替换的修正文本，可点「采纳」进入手动编辑）</div>`}
            <div class="kb-issue-actions">
              <button class="btn small primary" data-adopt="${i}">✅ 采纳修改</button>
              <button class="btn small ghost" data-ignore="${i}">🚫 忽略</button>
              <span class="result kb-adopt-result" id="${prefix}AdoptRes${i}"></span>
            </div>
          </div>` : ''}
        </div>`;
    const body = r.issues.length
      ? groups.map(g => `
        <div class="kb-issue-group" data-kb-sec="${g.sec}">
          <div class="kb-issue-group-head"><b>${GROUP_ICON[g.sec] || '📌 其他'}</b><span>· ${g.idxs.length} 处疑点</span><span class="kb-group-fixed" style="display:none;color:var(--ok);font-weight:600"></span></div>
          ${g.idxs.map(i => cardHtml(r.issues[i], i)).join('')}
        </div>`).join('')
      : '<div class="hint">✅ 未发现明显疑点（仅供参考，改动走人工编辑）</div>';
    out.innerHTML = head + body + `<div id="${prefix}LocateBox"></div>`;
    /* v1.1.7b：定位到此 → 弹窗直编（textarea 可改原文，保存同步库），附题型规则参考 */
    $$('#' + prefix + 'IssuesPanel [data-locate]').forEach(b => b.addEventListener('click', () => {
      const x = r.issues[+b.dataset.locate];
      kbOpenFixModal(prefix, id, x, +b.dataset.locate);
      if (x.itemIdx != null) {
        const el = $('#kbDetail [data-itemidx="' + x.itemIdx + '"]') || $('#exDetail [data-itemidx="' + x.itemIdx + '"]');
        if (el) {
          $$('#kbDetail .kb-locate, #exDetail .kb-locate').forEach(e2 => e2.classList.remove('kb-locate'));
          el.classList.add('kb-locate');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }));
    /* v2.1.2：采纳 AI 修正方案（有 fix 直接替换；无 fix 进手动编辑弹窗） */
    $$('#' + prefix + 'IssuesPanel [data-adopt]').forEach(b => b.addEventListener('click', () => {
      const x = r.issues[+b.dataset.adopt];
      kbAdoptFix(prefix, id, x, +b.dataset.adopt);
    }));
    $$('#' + prefix + 'IssuesPanel [data-ignore]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.ignore;
      const card = document.querySelector('#' + prefix + 'IssuesPanel .kb-issue[data-issue="' + i + '"]');
      if (!card) return;
      card.classList.add('kb-issue-ignored');
      const z = card.querySelector('[data-fixzone]');
      if (z) z.remove();
      const head = card.querySelector('.kb-issue-head');
      if (head && !card.querySelector('.kb-issue-ignored-tag')) {
        const t = document.createElement('span');
        t.className = 'kb-issue-ignored-tag';
        t.textContent = '🚫 已忽略';
        head.appendChild(t);
      }
    }));
  } catch (e) {
    out.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
  }
}

/* ---------------- v1.1.7b：疑点弹窗直编 ---------------- */

/* 题型编辑规则参考（按 itemTag 前缀匹配：type·section·题N） */
const KB_FIX_RULES = {
  'passage·use_of_english': '完形原文：挖空处必须保留 〖N〗 标记（N=1~20）；段落间空行分隔；不要改动挖空位置与数量。',
  'question·use_of_english': '完形选项：text 一般为空（(blank N) 占位即可）；options 必须是 A/B/C/D 四项；score=0.5。',
  'passage·reading': '阅读原文：划线句用 〖N〗…〖/N〗 包裹（仅翻译/指代题）；Text 间空行分隔；passage_id 标识所属篇。',
  'question·reading': '阅读题目：题干以题号自然顺序排布；options 为 A/B/C/D；score=2；passage_id 指向所属原文篇。',
  'passage·part_b': '新题型原文：空位必须保留 〖4x〗 标记（41~45）；options 池为 7 项数组（A~G）；score=null（按题给分）。',
  'passage·translation': '翻译原文：待译句用 〖4N〗…〖/4N〗 划线包裹（46~50）；划线句需与翻译题干完全一致。',
  'question·translation': '翻译题干：text 即划线句原文（与原文 〖N〗…〖/N〗 内文本一致）；score=2；answer=书写。',
  'writing·writing': '写作 Part A：小作文（10 分），text 含题目要求与字数；Part B：大作文（20 分），text 含图画描述指令。',
  'article': '文章：标题/正文自由文本，段落空行分隔；无 〖N〗 体系。',
  'note': '笔记：自由文本。',
  'document': '文档：自由文本。',
};
function kbFixRuleFor(tag) {
  const t = String(tag || '');
  if (!t) return '';
  const hit = Object.entries(KB_FIX_RULES).find(([k]) => t === k || t.startsWith(k + '·') || t.startsWith(k));
  return hit ? hit[1] : '';
}

/* v1.1.7c：弹窗预览高亮——AI 摘录(quote)在原文中标红。先精确 includes，
   失败用去空白规范化+位置映射（quote 跨 〖N〗 锚点或含换行差异时仍能命中） */
function kbFixHighlight(text, quote) {
  const raw = String(text || '');
  const q = String(quote || '').trim();
  let hit = -1, qlen = 0;
  if (q) {
    hit = raw.indexOf(q);
    if (hit >= 0) {
      qlen = q.length;
    } else {
      const map = [];   // norm 下标 -> raw 下标（跳过空白）
      let norm = '';
      for (let i = 0; i < raw.length; i++) {
        if (!/\s/.test(raw[i])) { norm += raw[i]; map.push(i); }
      }
      const nq = q.replace(/\s+/g, '');
      if (nq.length >= 4) {
        const at = norm.indexOf(nq);
        if (at >= 0) {
          hit = map[at];
          qlen = (at + nq.length < map.length) ? (map[at + nq.length] - hit) : (raw.length - hit);
        }
      }
    }
  }
  const html = (hit >= 0 && qlen > 0)
    ? esc(raw.slice(0, hit)) + '<mark class="kb-fix-hl">' + esc(raw.slice(hit, hit + qlen)) + '</mark>' + esc(raw.slice(hit + qlen))
    : esc(raw);
  return { html, hit };
}

/** v1.1.7d：就地更新详情页中该条目块的文本（不重建详情、不毁 AI 报告现场） */
function kbUpdateDetailItem(prefix, x, newText) {
  if (x.itemIdx == null) return;
  const el = $('#' + prefix + 'Detail [data-itemidx="' + x.itemIdx + '"]');
  if (!el) return;
  const qt = el.querySelector('.kb-q-text');
  if (qt) qt.innerHTML = kbText(newText);
  else el.innerHTML = kbText(newText);
}

/** v1.1.7e：疑点卡片状态标记——fixed=✅淡出+组头进度 / still=追加复核反馈与修改建议 */
function markIssueCard(prefix, cardIdx, state, newDesc, sug) {
  if (cardIdx == null || cardIdx < 0) return;
  /* v2.1.2：优先按 data-issue 找卡片（纯文本记录的疑点无「定位」按钮也能标记） */
  const card = document.querySelector('#' + prefix + 'IssuesPanel .kb-issue[data-issue="' + cardIdx + '"]') ||
    (() => { const btn = document.querySelector('#' + prefix + 'IssuesPanel [data-locate="' + cardIdx + '"]'); return btn && btn.closest('.kb-issue'); })();
  if (!card) return;
  if (state === 'fixed') {
    card.style.transition = 'opacity .8s'; card.style.opacity = '.45';
    const head = card.querySelector('.kb-issue-head');
    if (head && !card.querySelector('.kb-issue-fixed-tag')) {
      const t = document.createElement('span');
      t.className = 'kb-issue-fixed-tag';
      t.textContent = '✅ 已修复';
      head.appendChild(t);
    }
    const lb = card.querySelector('[data-locate]');
    if (lb) lb.disabled = true;
    const grp = card.closest('.kb-issue-group');
    if (grp) {
      const fixedEl = grp.querySelector('.kb-group-fixed');
      const total = grp.querySelectorAll('.kb-issue').length;
      const done = grp.querySelectorAll('.kb-issue-fixed-tag').length;
      if (fixedEl) { fixedEl.textContent = `· 已修复 ${done}/${total}`; fixedEl.style.display = ''; }
      if (done === total) grp.style.opacity = '.55';
    }
  } else if (state === 'still' && newDesc) {
    const d = document.createElement('div');
    d.className = 'kb-fix-miss';
    d.textContent = '🔁 AI 复核：' + newDesc;
    card.appendChild(d);
    if (sug) {
      const s = document.createElement('div');
      s.className = 'kb-fix-sug';
      s.textContent = '💡 修改建议：' + sug;
      card.appendChild(s);
    }
  }
}

/* v1.1.7e：保存后右下角 toast——一键回到 AI 审读板块 */
function kbShowBackToast(prefix, ok, msg) {
  const old = document.querySelector('.kb-back-toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'kb-back-toast' + (ok ? ' ok' : ' warn');
  t.innerHTML = `<div class="kb-back-msg">${esc(msg)}</div><button class="btn small primary">📋 回到审读报告</button>`;
  t.querySelector('button').addEventListener('click', () => {
    const panel = $('#' + prefix + 'IssuesPanel');
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (panel.animate) panel.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 900 });
    }
    t.remove();
  });
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 12000);
}

/* 疑点直编弹窗：textarea 改的即原始 itemText，保存走 /api/kb/record/update（整体 items 替换）*/
async function kbOpenFixModal(prefix, rid, x, cardIdx = -1) {
  kbCloseEditor();   // 关闭旧式全量编辑面板，避免状态交叉
  let rec = kbDetailState.rec;
  try {
    const r = await api('/api/kb/record/' + rid + '?raw=1');
    rec = kbDetailState.rec = r.record;
  } catch (e) { /* 拉取失败用已有 rec 兜底 */ }
  const items = (rec && rec.items) || [];
  /* v1.1.7b：rawIdx 由服务端 locate 回写（itemRawIdx，ordered 引用 == 原始 items 元素，indexOf 精确） */
  const rawIdx = (x.itemRawIdx != null && rec && Array.isArray(rec.items) && x.itemRawIdx < rec.items.length) ? x.itemRawIdx : -1;
  const origText = rawIdx >= 0 ? String(rec.items[rawIdx].text || '') : String(x.itemText || '');
  const rule = kbFixRuleFor(x.itemTag);
  const sevCls = { high: 'kb-issue-high', mid: 'kb-issue-mid', low: 'kb-issue-low' }[x.severity] || 'kb-issue-mid';
  let dlg = $('#kbFixModal');
  if (dlg) dlg.remove();
  dlg = document.createElement('div');
  dlg.id = 'kbFixModal';
  dlg.className = 'kb-fix-modal';
  dlg.innerHTML = `
    <div class="kb-fix-dialog">
      <div class="kb-fix-head">
        <div class="kb-fix-title">📍 疑点直编 · ${esc(x.itemTag || x.loc)} <span class="kb-issue-tag ${sevCls}">${esc(x.severity || 'mid')}</span></div>
        <button class="kb-fix-close" title="关闭">✕</button>
      </div>
      <div class="kb-fix-issue">${esc(x.desc || '')}${x.quote ? `<div class="kb-issue-quote">“${esc(x.quote)}”</div>` : ''}</div>
      ${rule ? `<div class="kb-fix-rule">📐 ${esc(rule)}</div>` : ''}
      <label class="field-label">🔍 疑点定位预览 <span style="font-weight:400">（<mark class="kb-fix-hl">红底纹</mark> = AI 认为有误处，随下方编辑实时更新）</span></label>
      <div id="kbFixPreview" class="kb-fix-preview"></div>
      <label class="field-label">条目原文（可直接修改，保存后同步题库；改动会写入 edited_at 留痕）</label>
      <textarea id="kbFixText" class="input kb-fix-text" rows="14">${esc(origText)}</textarea>
      <div class="kb-fix-actions">
        <button class="btn primary" id="kbFixSave">💾 保存到题库</button>
        <button class="btn ghost" id="kbFixCancel">关闭</button>
        ${rawIdx < 0 ? '<span class="hint">⚠️ 该疑点未能对齐到原始条目（定位降级），保存将不可用——请用「编辑」全量面板改。</span>' : ''}
      </div>
      <div class="result" id="kbFixResult"></div>
    </div>`;
  document.body.appendChild(dlg);
  /* v1.1.7e：滚动隔离——弹窗内滚动不穿透主界面（可滚元素内部放行，到边界/遮罩一律拦截） */
  dlg.addEventListener('wheel', e => {
    const scrollers = [$('#kbFixPreview'), $('#kbFixText'), dlg.querySelector('.kb-fix-dialog')].filter(Boolean);
    const t = scrollers.find(el => el === e.target || el.contains(e.target));
    if (t && t.scrollHeight > t.clientHeight) {
      const atTop = t.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) return;
    }
    e.preventDefault();
  }, { passive: false });
  /* v1.1.7c：预览区渲染——AI 摘录标红；编辑时节流刷新（改对了红纹即消失，直观反馈） */
  const pv = $('#kbFixPreview');
  const ta = $('#kbFixText');
  const renderPv = () => {
    const { html, hit } = kbFixHighlight(ta.value, x.quote);
    pv.innerHTML = (x.quote && hit < 0 ? '<div class="kb-fix-miss">⚠️ AI 摘录未在当前文本命中（可能已被修改或跨段截断）</div>' : '') + html;
    pv.scrollTop = 0;
  };
  renderPv();
  /* v1.1.8：移动端预览区默认折叠，点一下展开全文 */
  if (window.innerWidth <= 700) {
    pv.classList.add('kb-collapsed');
    pv.addEventListener('click', () => pv.classList.remove('kb-collapsed'), { once: true });
  }
  let pvTimer = null;
  ta.addEventListener('input', () => { clearTimeout(pvTimer); pvTimer = setTimeout(renderPv, 200); });

  const close = () => dlg.remove();
  dlg.querySelector('.kb-fix-close').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  $('#kbFixCancel').addEventListener('click', close);
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && document.body.contains(dlg)) { close(); document.removeEventListener('keydown', escClose); }
  });
  if (rawIdx < 0) return;   // 无法对齐：仅浏览，不出保存
  $('#kbFixSave').addEventListener('click', async () => {
    const out = $('#kbFixResult');
    const newText = $('#kbFixText').value;
    const body = { id: rid, items: rec.items.map((it, i) => {
      const o = {};
      for (const k of ['type', 'section', 'number', 'passage_id', 'options', 'qtype', 'score', 'part', 'answer']) {
        if (it[k] !== undefined && it[k] !== null) o[k] = it[k];
      }
      o.text = i === rawIdx ? newText : (it.text || '');
      return o;
    }) };
    out.textContent = '保存中…';
    out.className = 'result';
    try {
      await api('/api/kb/record/update', { method: 'POST', body });
      /* v1.1.7d：不重建详情、不退回列表——就地更新该条目块，保留 AI 审读现场 */
      if (prefix === 'kb') kbState.loaded = false; else examState.loaded = false;
      kbUpdateDetailItem(prefix, x, newText);
      out.innerHTML = '✅ 已保存 · 🤖 AI 复核中…';
      out.className = 'result';
      let rv = null;
      try { rv = await api('/api/kb/review/item', { id: rid, store: prefix === 'ex' ? 'exam' : 'corpus', rawIdx, text: newText, origText }); }
      catch (e2) { /* 复核异常不阻塞保存结果 */ }
      if (rv && rv.ok) {
        out.innerHTML = '✅ 已保存 · AI 复核通过，疑点已标记修复';
        out.className = 'result ok';
        markIssueCard(prefix, cardIdx, 'fixed');
        $('#kbFixPreview').innerHTML = '<div class="kb-fix-miss" style="color:var(--ok)">✅ AI 复核通过：该疑点已修复</div>';
        close();
        kbShowBackToast(prefix, true, '✅ 修改已保存，AI 复核通过');
      } else {
        const sug = (rv && rv.issues && rv.issues[0] && rv.issues[0].suggestion) || '';
        const d = (rv && rv.issues && rv.issues[0] && rv.issues[0].desc) || 'AI 复核未通过，请检查该条目';
        out.innerHTML = '✅ 已保存 · ⚠️ AI 复核仍有疑点：' + esc(d) + (sug ? `<div class="kb-fix-sug">💡 修改建议：${esc(sug)}</div>` : '');
        out.className = 'result err';
        markIssueCard(prefix, cardIdx, 'still', d, sug);
        kbShowBackToast(prefix, false, '⚠️ 已保存，AI 复核发现新问题');
      }
    } catch (e) {
      out.textContent = '❌ ' + esc(e.message);
      out.className = 'result err';
    }
  });
}

/* ---------------- v2.1.2：AI 修正采纳 与 历史版本回溯 ---------------- */

async function kbAdoptFix(prefix, rid, x, cardIdx) {
  const out = $(`#${prefix}AdoptRes${cardIdx}`);
  const card = document.querySelector('#' + prefix + 'IssuesPanel .kb-issue[data-issue="' + cardIdx + '"]');
  if (!x.fix) { kbOpenFixModal(prefix, rid, x, cardIdx); return; }   // 无修正方案 → 手动直编
  if (!confirm('采纳 AI 修正方案？\n\n原文摘录：“' + x.quote + '”\n\n修正为：“' + x.fix + '”\n\n（写回题库，可在「🕘 历史版本」中回退）')) return;
  if (out) { out.textContent = '提交中…'; out.className = 'result kb-adopt-result'; }
  try {
    const r = await api('/api/kb/review/apply', { method: 'POST', body: {
      id: rid, store: prefix === 'ex' ? 'exam' : 'corpus',
      itemRawIdx: x.itemRawIdx, quote: x.quote, fix: x.fix,
    } });
    if (out) { out.textContent = '✅ 已应用修正'; out.className = 'result ok kb-adopt-result'; }
    /* 就地刷新详情条目 + 标记疑点已修复（不重建整页，保留审读现场） */
    if (r.appliedText != null) {
      if (x.itemIdx != null) kbUpdateDetailItem(prefix, x, r.appliedText);
      else {
        /* 纯文本记录：直接刷新首个 passage 的渲染内容，不重建详情、不毁审读现场 */
        const el = $('#' + prefix + 'Detail .kb-passage');
        if (el) el.innerHTML = kbText(r.appliedText);
      }
    }
    markIssueCard(prefix, cardIdx, 'fixed');
    if (card) {
      const z = card.querySelector('[data-fixzone]');
      if (z) z.remove();
    }
    if (prefix === 'kb') kbState.loaded = false; else examState.loaded = false;
    toast('✅ 已采纳 AI 修正');
  } catch (e) {
    /* 摘录未命中（文本已被改动等）→ 降级到手动直编弹窗 */
    if (String(e.message).includes('未能在当前文本中命中')) {
      kbOpenFixModal(prefix, rid, x, cardIdx);
      return;
    }
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'result err kb-adopt-result'; }
  }
}

async function kbOpenHistory() {
  const { prefix, id } = kbDetailState;
  if (!id) return;
  let dlg = $('#kbHistoryModal');
  if (dlg) dlg.remove();
  dlg = document.createElement('div');
  dlg.id = 'kbHistoryModal';
  dlg.className = 'kb-fix-modal';
  dlg.innerHTML = `
    <div class="kb-fix-dialog kb-history-dialog">
      <div class="kb-fix-head">
        <div class="kb-fix-title">🕘 历史版本（最近 ${5} 个，改前自动留存）</div>
        <button class="kb-fix-close" title="关闭">✕</button>
      </div>
      <div id="kbHistoryBody" class="kb-history-body"><div class="hint">加载中…</div></div>
    </div>`;
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('.kb-fix-close').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.addEventListener('wheel', e => {
    const t = e.target.closest('.kb-history-body');
    if (t && t.scrollHeight > t.clientHeight) {
      const atTop = t.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) return;
    }
    if (!e.target.closest('.kb-history-body')) e.preventDefault();
  }, { passive: false });
  const body = $('#kbHistoryBody');
  try {
    const r = await api('/api/kb/versions?id=' + encodeURIComponent(id));
    if (!r.versions.length) {
      body.innerHTML = '<div class="hint">暂无历史版本——每次保存修改时会自动留存旧版本（最多 5 个）。</div>';
      return;
    }
    body.innerHTML = r.versions.map(v => `
      <div class="kb-history-item">
        <div class="kb-history-head">
          <b>${esc(fmtBJ(v.ts))}</b>
          <span class="hint">${esc(v.title || '')} · ${v.itemCount ? v.itemCount + ' 条目 · ' : ''}${v.chars} 字符</span>
        </div>
        <div class="hint">${esc(v.note || '')}</div>
        <div class="row-gap" style="margin-top:6px">
          <button class="btn small" data-restore="${v.index}">↩ 回退到此版本</button>
        </div>
      </div>`).join('');
    $$('#kbHistoryBody [data-restore]').forEach(b => b.addEventListener('click', async () => {
      const vi = +b.dataset.restore;
      const v = r.versions[vi];
      if (!confirm('回退到 ' + v.ts + ' 的版本？\n\n当前内容会先存入历史，可再次回退。')) return;
      b.disabled = true; b.textContent = '回退中…';
      try {
        await api('/api/kb/version/restore', { method: 'POST', body: { id, store: prefix === 'ex' ? 'exam' : 'corpus', versionIndex: vi } });
        close();
        toast('↩ 已回退到历史版本');
        if (prefix === 'kb') { kbState.loaded = false; loadKb(); openKbRecord(id); }
        else { examState.loaded = false; loadExamList(); openExamRecord(id); }
      } catch (e) {
        alert('回退失败：' + e.message);
        b.disabled = false; b.textContent = '↩ 回退到此版本';
      }
    }));
  } catch (e) {
    body.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
  }
}

$('#kbEditBtn').addEventListener('click', kbToggleEditor);
$('#exEditBtn').addEventListener('click', kbToggleEditor);
$('#kbDelBtn').addEventListener('click', kbDeleteCurrent);
$('#exDelBtn').addEventListener('click', kbDeleteCurrent);
$('#kbReviewBtn').addEventListener('click', kbDoReview);
$('#exReviewBtn').addEventListener('click', kbDoReview);
$('#kbHistoryBtn').addEventListener('click', kbOpenHistory);
$('#exHistoryBtn').addEventListener('click', kbOpenHistory);

/* ---------------- v2.1.2：划选精读学习（单词/词组/句子，PC 浮动 + 移动端底部卡片） ---------------- */
/* v2.3.3：借鉴 nextai-translator / Saladict / 沉浸式翻译——
   ① 解析卡片多模式 Tab（释义/直译/语法/例句）；② 双击查词；③ Esc 关闭；④ 一键收进墨墨云词库（Saladict 生词本交互 × 墨墨生态） */
/* v2.4.1：划词助手扩展到全站——不再限定容器白名单，正文/文章/词表/笔记等任意页面文本皆可划选；
   仍排除输入框、textarea、精读卡自身与编辑弹窗，交互控件区域不受影响。 */

const SEL_LEARN_READABLE = null;   // v2.4.1：null = 全站放行（原白名单 ['#kbDetail', '#exDetail', '#unitDetail'] 已弃用）
const SEL_LEARN_MODES = [
  { id: 'define', label: '📖 释义' },
  { id: 'translate', label: '🌐 直译' },
  { id: 'grammar', label: '🌳 语法' },
  { id: 'example', label: '💡 例句' },
];
let selLearnBtn = null;      // 选区旁的「精读」浮动按钮
let selLearnCard = null;     // 解析结果卡片
let selLearnState = null;    // { text, context, title, kind, rect, mode }
let selLearnReqSeq = 0;      // 并发保护：只认最后一次请求

function selLearnKindOf(text) {
  const t = String(text || '').trim();
  if (!t) return 'sentence';
  if (/^[A-Za-z][A-Za-z'-]*$/.test(t)) return 'word';
  const words = t.split(/\s+/).filter(Boolean);
  if (/^[A-Za-z0-9'’\-–—.,;:!?()\s]+$/.test(t) && words.length <= 5) return 'phrase';
  return 'sentence';
}

function selLearnInReadable(node) {
  /* v2.4.1：全站放行——按 DOM 结构判定“可读正文”：处于 body 内且不在编辑/交互件中即视为可读 */
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || !document.body.contains(el)) return null;
  if (el.closest('input, textarea, select, [contenteditable], .sel-learn-card, .kb-fix-modal, .modal-mask, nav.tab-group, .sidebar, .mobile-header, .mobile-bottom-bar, button, .btn')) return null;
  return el.closest('#kbDetail') || el.closest('#exDetail') || el.closest('#unitDetail') || el;
}

function selLearnContextOf(range, root) {
  try {
    const node = range.startContainer;
    const host = (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-itemidx]') ||
      (node.nodeType === 1 ? node : node.parentElement)?.closest('.kb-passage, .kb-question, .unit-q, .story-passage, .sel-learn-body, p, li, .card') || root;
    return String(host?.innerText || '').replace(/\s+\n/g, '\n').trim().slice(0, 3000);
  } catch { return ''; }
}

function selLearnTitleOf(root) {
  /* v2.4.1：全站场景取当前激活页签标题兜底 */
  const prefix = root.id === 'exDetail' ? 'ex' : (root.id === 'unitDetail' ? 'unit' : (root.id === 'kbDetail' ? 'kb' : ''));
  if (prefix) {
    const t = $(`#${prefix}DetailTitle`);
    if (t) return t.textContent.trim().slice(0, 100);
  }
  const active = document.querySelector('.tab.active');
  return active ? ('工作台 · ' + active.textContent.trim().slice(0, 60)) : '';
}

function selLearnRemoveBtn() {
  if (selLearnBtn) { selLearnBtn.remove(); selLearnBtn = null; }
}

function selLearnCloseCard() {
  if (selLearnCard) { selLearnCard.remove(); selLearnCard = null; }
  selLearnReqSeq++;
}

function selLearnShowBtn(rect) {
  selLearnRemoveBtn();
  const b = document.createElement('button');
  b.className = 'sel-learn-btn';
  b.type = 'button';
  b.innerHTML = '🔍 精读';
  b.title = '划选精读：单词 / 词组 / 句子';
  document.body.appendChild(b);
  const isMobile = window.innerWidth <= 700;
  if (!isMobile) {
    const x = Math.min(Math.max(8, rect.left + rect.width / 2 - 34), window.innerWidth - 84);
    const y = rect.top - 40 < 8 ? rect.bottom + 10 : rect.top - 40;
    b.style.left = x + 'px';
    b.style.top = y + 'px';
  }
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', e => { e.stopPropagation(); selLearnOpen(); });
  selLearnBtn = b;
}

/** v2.3.3：以指定模式请求解析结果（并发保护：只认最后一次请求） */
function selLearnRequest(card, mode, seq) {
  if (!selLearnState || !card) return;
  const bodyEl = card.querySelector('.sel-learn-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = '<div class="hint">AI 精读解析中…</div>';
  api('/api/selection/learn', {
    method: 'POST',
    body: { text: selLearnState.text, context: selLearnState.context, title: selLearnState.title, kind: selLearnState.kind, mode },
  })
    .then(r => {
      if (seq !== selLearnReqSeq || selLearnCard !== card) return;
      bodyEl.innerHTML = mdLite(r.reply || '（无解析结果）');
    })
    .catch(e => {
      if (seq !== selLearnReqSeq || selLearnCard !== card) return;
      bodyEl.innerHTML = '<div class="result err">❌ ' + esc(e.message) + '</div>';
    });
}

function selLearnOpen() {
  if (!selLearnState) return;
  const { text, context, title } = selLearnState;
  const kind = selLearnKindOf(text);
  selLearnRemoveBtn();
  selLearnCloseCard();
  const seq = ++selLearnReqSeq;
  const isMobile = window.innerWidth <= 700;
  const card = document.createElement('div');
  card.className = 'sel-learn-card' + (isMobile ? ' mobile' : '');
  card.innerHTML = `
    <div class="sel-learn-head">
      <span class="sel-learn-kind">${kind === 'word' ? '📖 单词' : kind === 'phrase' ? '🧩 词组' : '📝 句子'}</span>
      <span class="sel-learn-text">${esc(text.length > 120 ? text.slice(0, 120) + '…' : text)}</span>
      <button class="sel-learn-x" title="关闭">✕</button>
    </div>
    <div class="sel-learn-modes">
      ${SEL_LEARN_MODES.map(m => `<button class="sel-mode${m.id === 'define' ? ' active' : ''}" data-mode="${m.id}" type="button">${m.label}</button>`).join('')}
    </div>
    <div class="sel-learn-body"><div class="hint">AI 精读解析中…</div></div>
    <div class="sel-learn-foot">
      <button class="btn small" data-sel-speak>🔊 朗读</button>
      <button class="btn small ghost" data-sel-copy>📋 复制解析</button>
      <button class="btn small" data-sel-sentence>🧩 加入三遍训练</button>
      ${kind !== 'sentence' ? '<button class="btn small" data-sel-collect>➕ 收进墨墨</button>' : ''}
    </div>`;
  document.body.appendChild(card);
  selLearnCard = card;
  card.addEventListener('wheel', e => {
    const b = card.querySelector('.sel-learn-body');
    if (b && b.scrollHeight > b.clientHeight) {
      const atTop = b.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) return;
    }
    if (!e.target.closest('.sel-learn-body')) e.preventDefault();
  }, { passive: false });
  card.querySelector('.sel-learn-x').addEventListener('click', selLearnCloseCard);
  card.querySelector('[data-sel-speak]').addEventListener('click', () => speak(text));
  card.querySelector('[data-sel-sentence]').addEventListener('click', () => {
    selLearnCloseCard();
    stOpen({ text, context, title, sourceRef: selLearnState?.sourceRef || null });
  });
  card.querySelector('[data-sel-copy]').addEventListener('click', async () => {
    const c = card.querySelector('.sel-learn-body')?.innerText || '';
    try { await navigator.clipboard.writeText(c); toast('📋 已复制'); } catch { toast('复制失败'); }
  });
  /* v2.3.3：多模式切换——以新模式重新请求，并发序号保证只显示最后一次结果 */
  card.querySelectorAll('.sel-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      card.querySelectorAll('.sel-mode').forEach(b => b.classList.toggle('active', b === btn));
      selLearnRequest(card, btn.dataset.mode, ++selLearnReqSeq);
    });
  });
  /* v2.3.3：一键收进墨墨云词库（Saladict 生词本交互） */
  const collectBtn = card.querySelector('[data-sel-collect]');
  if (collectBtn) collectBtn.addEventListener('click', async () => {
    try {
      await api('/api/selection/collect', { method: 'POST', body: { spelling: text } });
      collectBtn.textContent = '✔ 已收进';
      collectBtn.disabled = true;
      toast('✅ 已收进墨墨云词库');
    } catch (e) {
      toast('❌ ' + e.message);
    }
  });
  selLearnRequest(card, 'define', seq);
}

/* 选区变化 → 显示浮动按钮（PC 鼠标 / 移动端长按划选均覆盖） */
function selLearnOnSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { selLearnRemoveBtn(); return; }
  const text = sel.toString().trim();
  if (!text || text.length < 1 || text.length > 600) { selLearnRemoveBtn(); return; }
  if (!/[\u4e00-\u9fa5]/.test(text) && !/[A-Za-z]/.test(text)) { selLearnRemoveBtn(); return; }
  const range = sel.getRangeAt(0);
  const root = selLearnInReadable(range.commonAncestorContainer);
  if (!root) { selLearnRemoveBtn(); return; }
  const cac = range.commonAncestorContainer;
  const cacEl = cac.nodeType === 1 ? cac : cac.parentElement;
  if (cacEl?.closest('input, textarea, .sel-learn-card, .kb-fix-modal')) { selLearnRemoveBtn(); return; }
  let rect;
  try { rect = range.getBoundingClientRect(); } catch { return; }
  if (!rect || (!rect.width && !rect.height)) return;
  const ridEl = cacEl?.closest?.('[data-rid]');
  let sourceRef = null;
  if (ridEl && ridEl.dataset.rid) {
    sourceRef = {
      rid: ridEl.dataset.rid,
      sourceKind: ridEl.dataset.sourceKind || null,
      year: ridEl.dataset.year ? Number(ridEl.dataset.year) : null,
      section: ridEl.dataset.section || null,
      sentence: text,   // 必须等于用户实际选区文本，不复用其他 DOM/旧状态
    };
  }
  selLearnState = { text, context: selLearnContextOf(range, root), title: selLearnTitleOf(root), kind: selLearnKindOf(text), rect, sourceRef, mode: 'define' };
  /* 移动端选区手柄遮挡浮动词：直接给底部「精读」条，点击即出卡片 */
  selLearnShowBtn(rect);
}

document.addEventListener('mouseup', e => {
  if (selLearnBtn && (e.target === selLearnBtn || selLearnBtn.contains(e.target))) return;
  setTimeout(selLearnOnSelection, 10);
});
document.addEventListener('touchend', e => {
  /* 点按精读条本身不触发重新检测（移动端 tap 会短暂改变选区，避免按钮被误移除） */
  if (selLearnBtn && (e.target === selLearnBtn || selLearnBtn.contains(e.target))) return;
  setTimeout(selLearnOnSelection, 120);
});
document.addEventListener('mousedown', e => {
  if (selLearnBtn && e.target === selLearnBtn) return;
  if (selLearnCard && selLearnCard.contains(e.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { selLearnRemoveBtn(); }
  }, 120);
});
/* v2.3.3：双击查词（Saladict 经典交互）——双击选词后自动弹出精读条 */
/* v2.4.1：全站放行——不在编辑件/弹窗内即可触发 */
document.addEventListener('dblclick', e => {
  if (!e.target || typeof e.target.closest !== 'function') return;
  if (e.target.closest('input, textarea, select, [contenteditable], .sel-learn-card, .kb-fix-modal, .modal-mask, button, .btn')) return;
  setTimeout(selLearnOnSelection, 30);
});
/* v2.3.3：Esc 关闭解析卡片（nextai-translator / 沉浸式翻译通用手势） */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && selLearnCard) {
    selLearnCloseCard();
    selLearnRemoveBtn();
  }
});

/* ---------------- v2.2.5：长难句三遍法训练 ---------------- */

const stState = {
  attemptId: null,
  mode: 'first',       // first | review
  text: '',
  context: '',
  title: '',
  sourceRef: null,
  triggeredBy: null,
};

function stEl(id) { return document.getElementById(id); }

function stOpen(opts = {}) {
  const overlay = stEl('stOverlay');
  if (!overlay) return;
  stState.mode = opts.mode || 'first';
  stState.attemptId = opts.attemptId || null;
  stState.text = opts.text || '';
  stState.context = opts.context || '';
  stState.title = opts.title || '';
  stState.sourceRef = opts.sourceRef || null;
  stState.triggeredBy = opts.triggeredBy || document.activeElement;

  stEl('stSource').textContent = opts.title ? `材料：${opts.title}` : (opts.sourceLabel || '');
  stEl('stSentence').textContent = opts.text || '';
  stEl('stStructure').value = opts.structure || '';
  stEl('stTranslation').value = opts.translation || '';
  stEl('stMsg').textContent = '';
  stEl('stMsg').className = 'result';
  stEl('stInputPane').style.display = 'block';
  stEl('stFeedbackPane').style.display = 'none';
  stEl('stFeedback').innerHTML = '';
  stEl('stSubmitBtn').disabled = false;
  stEl('stSubmitBtn').textContent = stState.mode === 'review' ? '提交复测，看对比反馈' : '提交，看 AI 分层反馈';
  overlay.style.display = 'flex';
  setTimeout(() => { const s = stEl('stStructure'); if (s) s.focus(); }, 30);
}

function stClose() {
  const overlay = stEl('stOverlay');
  if (overlay) overlay.style.display = 'none';
  const back = stState.triggeredBy;
  if (back && back.focus) { try { back.focus(); } catch {} }
}

/** 从仪表盘待复测任务打开（attemptId 为待复测记录 id） */
function stOpenReview(reviewAttemptId, prompt, meta) {
  const m = meta || {};
  stOpen({
    mode: 'review',
    attemptId: reviewAttemptId,
    text: prompt,
    title: m.title || '',
    sourceLabel: m.verifiedSource ? '真题/语料复测' : '手动选句复测',
    triggeredBy: document.activeElement,
  });
}

/** v2.2.8：从仪表盘待重试首答打开（attemptId 为 LLM 失败的首答记录，重做首答） */
function stOpenRetry(attemptId, prompt) {
  stOpen({
    mode: 'first',
    attemptId,
    text: prompt,
    sourceLabel: '首答重做（上次 AI 反馈生成失败）',
    triggeredBy: document.activeElement,
  });
}

async function stEnsureAttempt() {
  if (stState.attemptId) return stState.attemptId;
  const sourceRef = stState.sourceRef || null;
  const r = await api('/api/learning/sentence/start', {
    method: 'POST',
    body: {
      text: stState.text,
      context: stState.context || '',
      title: stState.title || '',
      sourceRef,
    },
  });
  stState.attemptId = r.attemptId;
  return r.attemptId;
}

async function stSubmit() {
  const structure = stEl('stStructure').value.trim();
  const translation = stEl('stTranslation').value.trim();
  const msg = stEl('stMsg');
  if (structure.length < 2 || translation.length < 2) {
    msg.textContent = '⚠️ 结构和自译都要填写后再提交';
    msg.className = 'result err';
    return;
  }
  const btn = stEl('stSubmitBtn');
  msg.textContent = 'AI 正在生成分层反馈…';
  msg.className = 'result';
  btn.disabled = true;
  let attemptId;
  try {
    attemptId = await stEnsureAttempt();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
    btn.disabled = false;
    return;
  }
  try {
    const r = await api('/api/learning/sentence/submit', {
      method: 'POST',
      body: {
        attemptId,
        structure,
        translation,
        startedAt: new Date().toISOString(),
      },
    });
    stEl('stFeedback').innerHTML = mdLite(r.feedback || '（无反馈）');
    stEl('stInputPane').style.display = 'none';
    stEl('stFeedbackPane').style.display = 'block';
    stEl('stReviewNote').innerHTML = r.isReview
      ? '<div class="hint">✅ 复测完成，对比结果见「复测对比」小节。</div>'
      : (r.dueAt ? `<div class="hint">📅 已安排 3 天后复测（${fmtBJ(r.dueAt)} 到期），届时可从仪表盘「待复测」进入。</div>` : '');
    // 反馈后不提供修改，防止刷分
    stState.attemptId = attemptId;
  } catch (e) {
    msg.textContent = '❌ ' + e.message + (e.message.includes('已保存') ? '（可再次点击提交重试）' : '');
    msg.className = 'result err';
    btn.disabled = false;
  }
}

if (stEl('stSubmitBtn')) stEl('stSubmitBtn').addEventListener('click', stSubmit);
if (stEl('stCloseBtn')) stEl('stCloseBtn').addEventListener('click', stClose);
if (stEl('stContinueBtn')) stEl('stContinueBtn').addEventListener('click', stClose);
if (stEl('stOverlay')) {
  stEl('stOverlay').addEventListener('click', e => { if (e.target === stEl('stOverlay')) stClose(); });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && stEl('stOverlay') && stEl('stOverlay').style.display !== 'none') {
    stClose();
  }
});

/* ---------------- 番茄钟 ---------------- */

const POMO_KEY = 'wb-pomo';
let pomo = (() => {
  try { return JSON.parse(localStorage.getItem(POMO_KEY)) || {}; } catch { return {}; }
})();
pomo = Object.assign({
  running: false, mode: 'work', endsAt: 0, remainingMs: 25 * 60000,
  workMin: 25, breakMin: 5, sessions: {},
}, pomo);

function pomoSave() { localStorage.setItem(POMO_KEY, JSON.stringify(pomo)); }
function pomoToday() { return pomo.sessions[bjDate()] || { count: 0, minutes: 0 }; }
function pomoRemaining() { return pomo.running ? Math.max(0, pomo.endsAt - Date.now()) : pomo.remainingMs; }

function pomoRender() {
  const ms = pomoRemaining();
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  const card = $('.pomo-card');
  if (card) card.classList.toggle('running', !!pomo.running);

  // 更新呼吸能量环进度 (周长 2 * PI * 70 ≈ 440)
  const ring = $('#pomoRingProgress');
  if (ring && pomo.fullMs > 0) {
    const totalMs = pomo.fullMs;
    const progress = Math.min(1, Math.max(0, ms / totalMs));
    const offset = 440 * (1 - progress);
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = pomo.mode === 'work' ? 'var(--primary)' : 'var(--ok)';
  }

  $('#pomoTime').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  $('#pomoTime').classList.toggle('break-mode', pomo.mode === 'break');
  const pill = $('#pomoMode');
  const state = pomo.running ? '' : (pomoRemaining() < pomo.fullMs ? '已暂停 · ' : '待开始 · ');
  pill.textContent = state + (pomo.mode === 'work' ? '专注' : '休息');
  pill.classList.toggle('break', pomo.mode === 'break');
  $('#pomoStartBtn').textContent = pomo.running ? '⏸ 暂停' : '▶ 开始';
}

function pomoRenderStats() {
  const t = pomoToday();
  $('#pomoCount').textContent = t.count;
  $('#pomoMinutes').textContent = t.minutes;
}

function pomoBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.3, 0.6].forEach(delay => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.25);
      osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + 0.25);
    });
  } catch { /* 无音频设备时静默 */ }
}

function pomoNext(counted) {
  if (pomo.mode === 'work') {
    if (counted) {
      const key = bjDate();
      const d = pomo.sessions[key] || { count: 0, minutes: 0 };
      d.count++; d.minutes += pomo.workMin;
      pomo.sessions[key] = d;
    }
    pomo.mode = 'break';
    pomo.fullMs = pomo.breakMin * 60000;
  } else {
    pomo.mode = 'work';
    pomo.fullMs = pomo.workMin * 60000;
  }
  pomo.remainingMs = pomo.fullMs;
  pomo.running = true;               // 自动进入下一段
  pomo.endsAt = Date.now() + pomo.fullMs;
  pomoSave(); pomoRender(); pomoRenderStats();
}

function pomoStartPause() {
  if (pomo.running) {
    pomo.remainingMs = Math.max(0, pomo.endsAt - Date.now());
    pomo.running = false;
  } else {
    if (!pomo.fullMs) pomo.fullMs = pomo.remainingMs;
    pomo.endsAt = Date.now() + pomo.remainingMs;
    pomo.running = true;
  }
  pomoSave(); pomoRender();
}

function pomoSkip() { pomoNext(false); }

function pomoReset() {
  pomo.mode = 'work';
  pomo.fullMs = pomo.workMin * 60000;
  pomo.remainingMs = pomo.fullMs;
  pomo.running = false;
  pomoSave(); pomoRender();
}

$('#pomoStartBtn').addEventListener('click', pomoStartPause);
$('#pomoSkipBtn').addEventListener('click', pomoSkip);
$('#pomoResetBtn').addEventListener('click', pomoReset);

$('#pomoWorkMin').addEventListener('change', () => {
  const v = Math.min(120, Math.max(1, Number($('#pomoWorkMin').value) || 25));
  $('#pomoWorkMin').value = v; pomo.workMin = v;
  if (pomo.mode === 'work' && !pomo.running) { pomo.fullMs = v * 60000; pomo.remainingMs = pomo.fullMs; }
  pomoSave(); pomoRender();
});
$('#pomoBreakMin').addEventListener('change', () => {
  const v = Math.min(60, Math.max(1, Number($('#pomoBreakMin').value) || 5));
  $('#pomoBreakMin').value = v; pomo.breakMin = v;
  if (pomo.mode === 'break' && !pomo.running) { pomo.fullMs = v * 60000; pomo.remainingMs = pomo.fullMs; }
  pomoSave(); pomoRender();
});

// 全局滴答：页面在哪个标签都照常计时
setInterval(() => {
  if (pomo.running && Date.now() >= pomo.endsAt) { pomoBeep(); pomoNext(true); }
  else if (!$('#tab-pomo').classList.contains('active')) return;
  pomoRender();
}, 500);

/* ---------------- 单词测验（v1.0.4：主动回忆 / v2.2.1：单题流水与三级信心） ---------------- */

const quiz = {
  running: false,
  src: 'today',
  mode: 'flash',
  items: [],
  idx: 0,
  results: [],
  distractorPool: [],
  confidence: 'unsure',
  itemStartedAt: null,
  submode: 'basic',
  advanceTimer: null,
};

/* v2.2.4：真题迁移训练状态 */
const transfer = {
  running: false,
  src: 'forget',
  kinds: { context: true, cloze: true },
  questions: [],
  idx: 0,
  results: [],
  itemStartedAt: null,
  confidence: 'unsure',
  answered: false,
  advanceTimer: null,
};

// 二级模式切换
$$('#quizSubmode .quiz-submode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#quizSubmode .quiz-submode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    quiz.submode = btn.dataset.submode;
    $('#quizBasicPane').style.display = quiz.submode === 'basic' ? 'block' : 'none';
    $('#quizTransferPane').style.display = quiz.submode === 'transfer' ? 'block' : 'none';
  });
});

// 迁移训练词源与题型开关
$$('#transferSources .chip').forEach(c => c.addEventListener('click', () => {
  $$('#transferSources .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  transfer.src = c.dataset.tsrc;
}));
$$('#transferKinds .chip').forEach(c => c.addEventListener('click', () => {
  c.classList.toggle('active');
  transfer.kinds[c.dataset.kind] = c.classList.contains('active');
}));

function resetQuizConfidence() {
  quiz.confidence = 'unsure';
  $$('#quizConfidenceGroup .quiz-conf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.conf === 'unsure');
  });
}

$$('#quizConfidenceGroup .quiz-conf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#quizConfidenceGroup .quiz-conf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    quiz.confidence = btn.dataset.conf || 'unsure';
  });
});

/* v2.2.8：迁移训练独立信心组（与基础测验互不复用，避免隐藏状态互相干扰） */
function resetTransferConfidence() {
  transfer.confidence = 'unsure';
  $$('#transferConfidenceGroup .transfer-conf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.conf === 'unsure');
  });
}

$$('#transferConfidenceGroup .transfer-conf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#transferConfidenceGroup .transfer-conf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    transfer.confidence = btn.dataset.conf || 'unsure';
  });
});

$$('#quizSources .chip').forEach(c => c.addEventListener('click', () => {
  $$('#quizSources .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  quiz.src = c.dataset.src;
}));
$$('#quizModes .chip').forEach(c => c.addEventListener('click', () => {
  $$('#quizModes .chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  quiz.mode = c.dataset.mode;
}));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

$('#quizStartBtn').addEventListener('click', startQuiz);
$('#quizQuitBtn').addEventListener('click', quitQuiz);

// 测验区的朗读按钮（事件委托）
$('#quizArea').addEventListener('click', (e) => {
  const b = e.target.closest('[data-speak]');
  if (b) speak(b.dataset.speak);
});

async function startQuiz() {
  const msg = $('#quizMsg');
  msg.textContent = '正在准备题目…';
  msg.className = 'result';
  try {
    const d = await api(`/api/words?filter=${quiz.src}`);
    let pool = d.words || [];
    if (pool.length < 3) {
      msg.textContent = '⚠️ 该词源下单词太少（不足 3 个），换个词源或先去学习/同步';
      msg.className = 'result err';
      return;
    }
    const count = Math.min(50, Math.max(3, Number($('#quizCount').value) || 10));
    pool = shuffle(pool).slice(0, count);
    // 补齐释义（判分依赖），获取不到的词跳过
    const missing = pool.filter(w => !w.gloss).map(w => w.spelling);
    if (missing.length) {
      const g = await api('/api/gloss', { method: 'POST', body: { spellings: missing } });
      pool.forEach(w => { if (g.glosses?.[w.spelling]) w.gloss = g.glosses[w.spelling]; });
    }
    const withGloss = pool.filter(w => w.gloss?.gloss);
    if (withGloss.length < 3) {
      msg.textContent = '⚠️ 释义获取失败（请检查设置页的 AI 服务商），暂时出不了题';
      msg.className = 'result err';
      return;
    }
    quiz.items = withGloss;
    quiz.idx = 0;
    quiz.results = [];
    quiz.running = true;
    // 四选一的干扰项池
    if (quiz.mode === 'choice') {
      const all = await api('/api/words?filter=all');
      quiz.distractorPool = (all.words || []).filter(w => w.gloss?.gloss);
    }
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    $('#quizConfidenceGroup').style.display = '';
    renderQuizItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

function quitQuiz() {
  quiz.running = false;
  transfer.running = false;
  transfer.answered = false;
  if (quiz.advanceTimer) { clearTimeout(quiz.advanceTimer); quiz.advanceTimer = null; }
  if (transfer.advanceTimer) { clearTimeout(transfer.advanceTimer); transfer.advanceTimer = null; }
  $('#quizRun').style.display = 'none';
  $('#quizSetup').style.display = 'block';
  $('#quizConfidenceGroup').style.display = '';
  $('#transferConfidenceGroup').style.display = 'none';
}

function quizAdvance() {
  if (!quiz.running) return;
  quiz.idx++;
  if (quiz.idx >= quiz.items.length) return finishQuiz();
  renderQuizItem();
}

function quizRecord(resp, extra = {}) {
  const it = quiz.items[quiz.idx];
  const now = Date.now();
  const startT = quiz.itemStartedAt ? new Date(quiz.itemStartedAt).getTime() : now;
  const durationMs = Math.max(0, Math.min(14400000, now - startT));

  quiz.results.push({
    spelling: it.spelling,
    response: resp,
    mode: quiz.mode,
    prompt: it.spelling,
    expected: it.gloss?.gloss || '',
    userAnswer: extra.userAnswer !== undefined ? String(extra.userAnswer) : resp,
    confidence: quiz.confidence || 'unsure',
    startedAt: quiz.itemStartedAt || new Date(now - durationMs).toISOString(),
    submittedAt: new Date(now).toISOString(),
    durationMs,
  });
}

function renderQuizItem() {
  const it = quiz.items[quiz.idx];
  quiz.itemStartedAt = new Date().toISOString();
  resetQuizConfidence();
  $('#quizProgress').textContent = `第 ${quiz.idx + 1} / ${quiz.items.length} 题`;
  $('#quizBar').style.width = (quiz.idx / quiz.items.length * 100) + '%';
  const area = $('#quizArea');

  if (quiz.mode === 'flash') {
    area.innerHTML = `
      <div class="quiz-word">${esc(it.spelling)} <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button>
        ${it.gloss?.phonetic ? `<div class="phonetic">${esc(it.gloss.phonetic)}</div>` : ''}</div>
      <div class="quiz-hint">想一想它的中文意思，再翻面对答案</div>
      <div class="quiz-flip-zone" id="quizFlipZone">
        <button class="btn primary" id="quizFlipBtn">🔄 翻面看答案</button>
      </div>`;
    $('#quizFlipBtn').addEventListener('click', () => {
      $('#quizFlipZone').innerHTML = `
        <div class="quiz-answer"><span class="pos">${esc(it.gloss.pos || '')}</span>${esc(it.gloss.gloss)}</div>
        <div class="grade-row">
          <button class="btn grade g-ok" data-r="FAMILIAR">😊 认识</button>
          <button class="btn grade g-mid" data-r="VAGUE">😐 模糊</button>
          <button class="btn grade g-bad" data-r="FORGET">😵 忘记</button>
        </div>`;
      $$('#quizFlipZone .grade').forEach(b =>
        b.addEventListener('click', () => { quizRecord(b.dataset.r); quizAdvance(); }));
    });
    return;
  }

  if (quiz.mode === 'choice') {
    const distractors = shuffle(quiz.distractorPool.filter(w => w.spelling !== it.spelling))
      .slice(0, 3).map(w => w.gloss.gloss);
    const opts = shuffle([{ ok: true, text: it.gloss.gloss }, ...distractors.map(t => ({ ok: false, text: t }))]);
    area.innerHTML = `
      <div class="quiz-word">${esc(it.spelling)} <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button></div>
      <div class="quiz-hint">选出正确的释义</div>
      <div class="quiz-opts">${opts.map((o, i) => `<button class="btn quiz-opt" data-i="${i}">${esc(o.text)}</button>`).join('')}</div>
      <div class="quiz-feedback" id="quizFeedback"></div>`;
    let answered = false;
    $$('#quizArea .quiz-opt').forEach(b => b.addEventListener('click', () => {
      if (answered) return;
      answered = true;
      const pickedOpt = opts[Number(b.dataset.i)];
      const ok = pickedOpt.ok;
      b.classList.add(ok ? 'correct' : 'wrong');
      $('#quizFeedback').innerHTML = ok
        ? '<span class="fb-ok">✅ 答对了</span>'
        : `<span class="fb-bad">❌ 正确答案：<b>${esc(it.gloss.gloss)}</b></span>`;
      quizRecord(ok ? 'FAMILIAR' : 'FORGET', { userAnswer: pickedOpt.text });
      quiz.advanceTimer = setTimeout(quizAdvance, ok ? 700 : 1800);
    }));
    return;
  }

  // 拼写模式：给中文释义，拼出单词
  area.innerHTML = `
    <div class="quiz-answer"><span class="pos">${esc(it.gloss.pos || '')}</span>${esc(it.gloss.gloss)}</div>
    <div class="quiz-hint">根据释义拼出这个单词（按回车提交）</div>
    <div class="quiz-spell-row">
      <input type="text" id="quizSpellInput" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入拼写…">
      <button class="btn primary" id="quizSpellBtn">提交</button>
    </div>
    <div class="quiz-feedback" id="quizFeedback"></div>`;
  const input = $('#quizSpellInput');
  input.focus();
  const submit = () => {
    const val = input.value.trim();
    if (!val) return;
    const ok = val.toLowerCase() === it.spelling.toLowerCase();
    $('#quizFeedback').innerHTML = ok
      ? `<span class="fb-ok">✅ 拼对了！${esc(it.spelling)}</span>`
      : `<span class="fb-bad">❌ 正确拼写：<b>${esc(it.spelling)}</b> <button class="speak-btn mini" data-speak="${esc(it.spelling)}">🔊</button></span>`;
    input.disabled = true;
    $('#quizSpellBtn').disabled = true;
    quizRecord(ok ? 'FAMILIAR' : 'FORGET', { userAnswer: val });
    quiz.advanceTimer = setTimeout(quizAdvance, ok ? 700 : 2000);
  };
  $('#quizSpellBtn').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function finishQuiz() {
  quiz.running = false;
  $('#quizBar').style.width = '100%';
  $('#quizProgress').textContent = '测验完成 🎉';
  const r = quiz.results;
  const cnt = k => r.filter(x => x.response === k).length;
  let submitNote = '';
  try {
    await api('/api/quiz/submit', { method: 'POST', body: { results: r, mode: quiz.mode } });
    submitNote = '结果已记录：忘记/模糊的词自动进入了对应筛选，回「AI 学习」页可针对性攻克。';
  } catch {
    submitNote = '（结果上报失败，本次不计入错词统计）';
  }
  $('#quizArea').innerHTML = `
    <div class="quiz-done">
      <div class="quiz-score">${cnt('FAMILIAR')} / ${r.length}</div>
      <div class="quiz-score-sub">认识 ${cnt('FAMILIAR')} · 模糊 ${cnt('VAGUE')} · 忘记 ${cnt('FORGET')}</div>
      <div class="hint" style="text-align:center">${esc(submitNote)}</div>
      <div class="row-gap" style="justify-content:center">
        <button class="btn primary" id="quizAgainBtn">🔁 再来一轮</button>
        <button class="btn" data-jump="study" data-filter="forget">去学错词</button>
      </div>
    </div>`;
  $('#quizAgainBtn').addEventListener('click', quitQuiz);
}

/* ---------------- v2.2.4：真题迁移训练 ---------------- */

async function startTransfer() {
  const msg = $('#transferMsg');
  const kinds = transfer.kinds;
  if (!kinds.context && !kinds.cloze) {
    msg.textContent = '⚠️ 请至少开启一种题型（语境选义或搭配补全）';
    msg.className = 'result err';
    return;
  }
  const count = Math.min(20, Math.max(3, Number($('#transferCount').value) || 6));
  msg.textContent = '正在从真题句中生成迁移题…';
  msg.className = 'result';
  try {
    const r = await api('/api/learning/vocab/generate', {
      method: 'POST',
      body: { filter: transfer.src, count, context: kinds.context, cloze: kinds.cloze },
    });
    const questions = r.questions || [];
    if (!questions.length) {
      msg.textContent = '⚠️ ' + (r.message || '暂无可生成的迁移题');
      msg.className = 'result err';
      return;
    }
    transfer.questions = questions;
    transfer.idx = 0;
    transfer.results = [];
    transfer.running = true;
    transfer.answered = false;
    if (transfer.advanceTimer) { clearTimeout(transfer.advanceTimer); transfer.advanceTimer = null; }
    msg.textContent = '';
    $('#quizSetup').style.display = 'none';
    $('#quizRun').style.display = 'block';
    // 迁移训练使用独立信心组，隐藏基础测验信心组
    $('#quizConfidenceGroup').style.display = 'none';
    $('#transferConfidenceGroup').style.display = '';
    renderTransferItem();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.className = 'result err';
  }
}

function transferAdvance() {
  if (!transfer.running) return;
  transfer.idx++;
  if (transfer.idx >= transfer.questions.length) return finishTransfer();
  renderTransferItem();
}

function renderTransferItem() {
  const q = transfer.questions[transfer.idx];
  transfer.itemStartedAt = new Date().toISOString();
  transfer.answered = false;
  resetTransferConfidence();   // 每题重置为 unsure
  $('#quizProgress').textContent = `第 ${transfer.idx + 1} / ${transfer.questions.length} 题`;
  $('#quizBar').style.width = (transfer.idx / transfer.questions.length * 100) + '%';
  const area = $('#quizArea');

  const kindBadge = q.kind === 'vocab_cloze'
    ? '<span class="transfer-kind-badge cloze">搭配补全</span>'
    : '<span class="transfer-kind-badge">语境选义</span>';
  const srcLabel = [q.sourceLabel, q.title].filter(Boolean).join(' · ');

  if (q.kind === 'vocab_context') {
    const optHtml = (q.options || []).map((text, i) =>
      `<button type="button" class="btn quiz-opt transfer-opt" data-i="${i}">${esc(text)}</button>`).join('');
    area.innerHTML = `
      <div class="transfer-meta">${kindBadge}<span class="tag">${esc(srcLabel)}</span></div>
      <div class="transfer-source-sentence">${esc(q.sentence)}</div>
      <div class="quiz-hint">选出 <b>${esc(q.word)}</b> 在这句真题中的正确释义</div>
      <div class="quiz-opts" id="transferOpts">${optHtml}</div>
      <div class="quiz-feedback" id="quizFeedback"></div>`;
    let done = false;
    $$('#quizArea .transfer-opt').forEach(b => b.addEventListener('click', () => {
      if (done) return;
      done = true;
      transfer.answered = true;
      const picked = q.options[Number(b.dataset.i)];
      submitTransfer(q, picked);
    }));
    return;
  }

  // 搭配补全：文本输入
  area.innerHTML = `
    <div class="transfer-meta">${kindBadge}<span class="tag">${esc(srcLabel)}</span></div>
    <div class="transfer-source-sentence">${esc(q.sentence)}</div>
    <div class="quiz-hint">根据句意与词形，补全横线处的单词（原形：<b>${esc(q.word)}</b>）</div>
    <div class="quiz-spell-row">
      <input type="text" id="transferInput" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入缺失的单词…">
      <button class="btn primary" id="transferSubmitBtn">提交</button>
    </div>
    <div class="quiz-feedback" id="quizFeedback"></div>`;
  const input = $('#transferInput');
  input.focus();
  const doSubmit = () => {
    if (transfer.answered) return;
    const val = input.value.trim();
    if (!val) return;
    transfer.answered = true;
    input.disabled = true;
    $('#transferSubmitBtn').disabled = true;
    submitTransfer(q, val);
  };
  $('#transferSubmitBtn').addEventListener('click', doSubmit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
}

async function submitTransfer(q, answer) {
  const now = Date.now();
  const startT = transfer.itemStartedAt ? new Date(transfer.itemStartedAt).getTime() : now;
  const durationMs = Math.max(0, Math.min(14400000, now - startT));
  let correct = false;
  let expected = '';
  try {
    const r = await api('/api/learning/vocab/submit', {
      method: 'POST',
      body: {
        token: q.token,
        answer,
        confidence: transfer.confidence || 'unsure',   // v2.2.8：发送真实信心，不再固定 unsure
        startedAt: transfer.itemStartedAt,
        durationMs,
      },
    });
    correct = !!r.correct;
    expected = r.expected || '';
  } catch (e) {
    $('#quizFeedback').innerHTML = `<span class="fb-bad">❌ 提交失败：${esc(e.message)}</span>`;
    // 允许重试
    transfer.answered = false;
    return;
  }

  transfer.results.push({ word: q.word, kind: q.kind, answer, expected, correct });

  // 高亮反馈
  if (q.kind === 'vocab_context') {
    $$('#quizArea .transfer-opt').forEach(b => {
      const text = q.options[Number(b.dataset.i)];
      if (text === expected) b.classList.add('correct');
      else if (text === answer && !correct) b.classList.add('wrong');
    });
  }
  $('#quizFeedback').innerHTML = correct
    ? '<span class="fb-ok">✅ 正确</span>'
    : `<span class="fb-bad">❌ 正确答案：<b>${esc(expected)}</b></span>`;
  transfer.advanceTimer = setTimeout(transferAdvance, correct ? 800 : 1800);
}

async function finishTransfer() {
  transfer.running = false;
  if (transfer.advanceTimer) { clearTimeout(transfer.advanceTimer); transfer.advanceTimer = null; }
  $('#quizBar').style.width = '100%';
  $('#quizProgress').textContent = '迁移训练完成 🎯';
  $('#transferConfidenceGroup').style.display = 'none';
  const r = transfer.results;
  const correctN = r.filter(x => x.correct).length;
  const ctx = r.filter(x => x.kind === 'vocab_context');
  const cloze = r.filter(x => x.kind === 'vocab_cloze');
  const wrongWords = [...new Set(r.filter(x => !x.correct).map(x => x.word))];

  const wrongHtml = wrongWords.length
    ? `<div class="transfer-wrong-list">${wrongWords.map(w => `<button type="button" class="transfer-wrong-chip" data-word="${esc(w)}">${esc(w)}</button>`).join('')}</div>`
    : '<div class="hint" style="text-align:center">本轮全部答对，状态不错 👏</div>';

  $('#quizArea').innerHTML = `
    <div class="quiz-done">
      <div class="quiz-score">${correctN} / ${r.length}</div>
      <div class="transfer-done-sub">
        语境选义 ${ctx.filter(x => x.correct).length}/${ctx.length} · 搭配补全 ${cloze.filter(x => x.correct).length}/${cloze.length}
      </div>
      <div class="hint" style="text-align:center">${wrongWords.length ? '错词已计入「忘记词」，点击下方词或去 AI 学习攻克：' : ''}</div>
      ${wrongHtml}
      <div class="row-gap" style="justify-content:center">
        <button class="btn primary" id="transferAgainBtn">🔁 再来一组</button>
        <button class="btn" id="transferToStudyBtn" data-jump="study" data-filter="forget">去学错词</button>
      </div>
    </div>`;
  $('#transferAgainBtn').addEventListener('click', () => {
    $('#quizRun').style.display = 'none';
    $('#quizSetup').style.display = 'block';
    $('#transferConfidenceGroup').style.display = 'none';
  });
  $$('#quizArea .transfer-wrong-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      switchTab('study');
      $('#wordSearch').value = chip.dataset.word;
      loadWords();
    });
  });
}

if ($('#transferStartBtn')) $('#transferStartBtn').addEventListener('click', startTransfer);

/* ---------------- 启动 ---------------- */

(async function init() {
  applyTheme(localStorage.getItem('wb-theme') || 'light');
  applyStyle(localStorage.getItem('wb-style') || '');
  // 番茄钟初始化：恢复上次进度（若页面关闭期间已到点，计入完成）
  if (!pomo.fullMs) pomo.fullMs = pomo.workMin * 60000;
  pomoRender();
  pomoRenderStats();
  // v2.1.0：启动即拉取 DIY 提示词，使学习页首句开场等自定义提示词无需进设置页即可生效
  try {
    const cfg = await api('/api/config');
    if (cfg.diyPrompts) state.diyPrompts = cfg.diyPrompts;
    // v2.3.4：启动拉取服务商档案（含视觉能力），控制学习页图片按钮显隐
    state.providers = cfg.llm?.providers || [];
    state.activeProvId = cfg.llm?.activeId || '';
  } catch { /* 服务未就绪时静默 */ }
  refreshVisionUI();
  try {
    const status = await api('/api/status');
    updateSyncBadge(status.lastSync ? 'ok' : 'err', status.lastSync ? formatTime(status.lastSync) : '未同步');
    if (!status.hasToken || !status.llm.configured) {
      $('#setupHint').style.display = 'block';
    }
  } catch { /* 服务未就绪时静默 */ }
  loadDashboard();
})();

/* ============ v1.1.9c：禅意专注视界 + 视线探照灯 + 原生白噪音心流场 ============ */

/* 1. 禅意专注模式 (Zen Mode) */
function toggleZenMode() {
  const isZen = document.body.classList.toggle('zen-mode');
  localStorage.setItem('wb-zen', isZen ? '1' : '0');
  const btn = $('#zenToggle');
  if (btn) btn.textContent = isZen ? '🧘‍♂️' : '🧘';
  if (isZen) {
    // v2.0.0.a：开启专注禅模式自动开启番茄钟
    if (!pomo.running) {
      if (!pomo.fullMs) pomo.fullMs = pomo.remainingMs || (pomo.workMin * 60000);
      pomo.endsAt = Date.now() + (pomo.remainingMs || pomo.fullMs);
      pomo.running = true;
      pomoSave();
      pomoRender();
    }
    toast('已进入禅意专注视界（番茄钟已同步开启，按 Esc 或 Z 退出）');
  } else {
    toast('已退出专注视界');
  }
}

if ($('#zenToggle')) $('#zenToggle').addEventListener('click', toggleZenMode);
if ($('#zenFloatingExit')) $('#zenFloatingExit').addEventListener('click', toggleZenMode);

/* 2. 考研段落探照灯 (Spotlight Focus) */
function toggleSpotlight() {
  const isActive = document.body.classList.toggle('spotlight-active');
  localStorage.setItem('wb-spotlight', isActive ? '1' : '0');
  const btn = $('#spotlightToggleFloating');
  if (btn) btn.classList.toggle('active', isActive);
  toast(isActive ? '已开启段落探照灯（长难句防跳行）' : '已关闭段落探照灯');
}

if ($('#spotlightToggleFloating')) $('#spotlightToggleFloating').addEventListener('click', toggleSpotlight);

/* 快捷键监听：Z 键切换禅模式，S 键切换探照灯，Esc 退出禅模式 */
window.addEventListener('keydown', e => {
  const tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    toggleZenMode();
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    toggleSpotlight();
  } else if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) {
    e.preventDefault();
    toggleZenMode();
  }
});

/* 3. 纯原生 Web Audio 算法白噪音心流发生器（v2.1.0a：并入番茄钟 · 10 种可选 · 音量可调）
      零外链、零音频文件下载，全部实时合成。 */
let audioCtx = null;
let noiseNode = null;
let noiseLfo = null;
let noiseLfoGain = null;
let gainNode = null;
let currentNoiseMode = 'off';

const NOISE_TYPES = {
  off:    { name: '已关闭' },
  rain:   { name: '雨落窗台',   color: 'pink',  filter: { type: 'lowpass',  freq: 1300, q: 0.7 }, gain: 0.95 },
  cafe:   { name: '深空自习室', color: 'brown', filter: { type: 'lowpass',  freq: 520,  q: 0.7 }, gain: 0.85 },
  forest: { name: '林间清晨',   color: 'pink',  filter: { type: 'bandpass', freq: 3000, q: 0.6 }, gain: 1.10 },
  ocean:  { name: '海浪拍岸',   color: 'brown', filter: { type: 'lowpass',  freq: 750,  q: 0.7 }, gain: 1.15, lfo: { freq: 0.12, depth: 0.85 } },
  fire:   { name: '壁炉篝火',   color: 'brown', filter: { type: 'lowpass',  freq: 950,  q: 0.7 }, gain: 0.90, crackle: true },
  night:  { name: '夏夜虫鸣',   color: 'pink',  filter: { type: 'bandpass', freq: 4300, q: 1.3 }, gain: 1.00, lfo: { freq: 6, depth: 0.25 } },
  stream: { name: '山涧溪流',   color: 'white', filter: { type: 'bandpass', freq: 2600, q: 0.8 }, gain: 0.90 },
  brown:  { name: '棕噪音',     color: 'brown', filter: { type: 'lowpass',  freq: 600,  q: 0.7 }, gain: 0.90 },
  white:  { name: '纯白噪音',   color: 'white', filter: { type: 'lowpass',  freq: 6000, q: 0.7 }, gain: 0.50 },
};

let noiseVolume = (() => {
  const raw = localStorage.getItem('wb-noise-vol');
  if (raw === null || raw === '') return 45;   // 注意：Number(null)===0，不能直接转
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 45;
})();

function noiseTargetGain(type) {
  const cfg = NOISE_TYPES[type];
  if (!cfg || !cfg.gain) return 0;
  return Math.min(1, cfg.gain * (noiseVolume / 100) * 0.4);
}

function createNoiseBuffer(color, crackle) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const bufferSize = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  if (color === 'pink') {
    // 粉红噪声：雨声 / 自然声质感
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
      b6 = white * 0.115926;
    }
  } else if (color === 'brown') {
    // 布朗噪声：厚重遮噪
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      data[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = data[i];
      data[i] *= 0.8;
    }
  } else {
    // 纯白噪声
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  }

  // 篝火噼啪：叠加随机短促脉冲
  if (crackle) {
    for (let i = 0; i < bufferSize; i++) {
      if (Math.random() < 0.00012) {
        const pop = (Math.random() * 2 - 1) * 0.9;
        const len = Math.floor(audioCtx.sampleRate * (0.005 + Math.random() * 0.02));
        for (let j = 0; j < len && i + j < bufferSize; j++) {
          data[i + j] += pop * Math.exp(-j / (len / 4));
        }
        i += len;
      }
    }
  }
  return buffer;
}

function stopNoise() {
  if (gainNode && audioCtx) {
    try {
      gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    } catch (e) {}
  }
  const node = noiseNode, lfo = noiseLfo;
  noiseNode = null; noiseLfo = null; noiseLfoGain = null;
  if (node || lfo) {
    setTimeout(() => {
      try { if (node) { node.stop(); node.disconnect(); } } catch (e) {}
      try { if (lfo) { lfo.stop(); lfo.disconnect(); } } catch (e) {}
    }, 380);
  }
}

function startNoise(type) {
  stopNoise();
  const cfg = NOISE_TYPES[type];
  if (!cfg || !cfg.gain) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const buffer = createNoiseBuffer(cfg.color, cfg.crackle);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type = cfg.filter.type;
    filter.frequency.value = cfg.filter.freq;
    filter.Q.value = cfg.filter.q;

    const g = audioCtx.createGain();
    const target = noiseTargetGain(type);
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, target), audioCtx.currentTime + 1.0);

    src.connect(filter);
    filter.connect(g);
    g.connect(audioCtx.destination);
    src.start();

    let lfo = null, lfoGain = null;
    if (cfg.lfo) {
      lfo = audioCtx.createOscillator();
      lfo.frequency.value = cfg.lfo.freq;
      lfoGain = audioCtx.createGain();
      lfoGain.gain.value = target * cfg.lfo.depth;
      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);
      lfo.start();
    }

    noiseNode = src; gainNode = g; noiseLfo = lfo; noiseLfoGain = lfoGain;
  } catch (err) {
    console.warn('AudioContext failed:', err);
  }
}

function setNoiseVolume(v) {
  noiseVolume = Math.max(0, Math.min(100, Number(v) || 0));
  localStorage.setItem('wb-noise-vol', String(noiseVolume));
  const label = $('#noiseVolVal');
  if (label) label.textContent = noiseVolume + '%';
  const slider = $('#noiseVolume');
  if (slider && Number(slider.value) !== noiseVolume) slider.value = noiseVolume;
  const cfg = NOISE_TYPES[currentNoiseMode];
  if (gainNode && audioCtx && cfg && cfg.gain) {
    const target = noiseTargetGain(currentNoiseMode);
    try {
      gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, target), audioCtx.currentTime + 0.25);
    } catch (e) {}
    if (noiseLfoGain && cfg.lfo) noiseLfoGain.gain.value = target * cfg.lfo.depth;
  }
}

function applyNoise(type, silent) {
  if (!NOISE_TYPES[type]) type = 'off';
  currentNoiseMode = type;
  localStorage.setItem('wb-noise', type);
  $$('#noiseGrid .noise-opt').forEach(b => b.classList.toggle('active', b.dataset.noise === type));
  const cur = $('#noiseCurrent');
  if (cur) cur.textContent = NOISE_TYPES[type].name;
  startNoise(type);
  if (!silent) toast(type === 'off' ? '🎧 白噪音已关闭' : `🎧 白噪音：${NOISE_TYPES[type].name}`);
}

/* 绑定白噪音选择器与音量（v2.1.0a） */
$$('#noiseGrid .noise-opt').forEach(b => b.addEventListener('click', () => applyNoise(b.dataset.noise)));
if ($('#noiseVolume')) {
  $('#noiseVolume').value = noiseVolume;
  $('#noiseVolume').addEventListener('input', () => setNoiseVolume($('#noiseVolume').value));
}
/* 初始化 UI：恢复上次选择（遵照浏览器自动播放策略，不自动发声，需用户点击才播放） */
(function initNoiseUi() {
  const saved = localStorage.getItem('wb-noise') || 'off';
  const type = NOISE_TYPES[saved] ? saved : 'off';
  currentNoiseMode = type;
  $$('#noiseGrid .noise-opt').forEach(b => b.classList.toggle('active', b.dataset.noise === type));
  const cur = $('#noiseCurrent');
  if (cur) cur.textContent = NOISE_TYPES[type].name;
  const label = $('#noiseVolVal');
  if (label) label.textContent = noiseVolume + '%';
})();

/* 恢复本地存储的偏好 */
if (localStorage.getItem('wb-spotlight') === '1') {
  document.body.classList.add('spotlight-active');
  const btn = $('#spotlightToggleFloating');
  if (btn) btn.classList.add('active');
}


/* ============ v1.2.0：数据备份管理 ============ */
async function loadBackupList() {
  const el = $('#backupList');
  if (!el) return;
  try {
    const d = await api('/api/backup/list');
    if (!d.backups?.length) { el.innerHTML = '<div class="empty">暂无备份</div>'; return; }
    el.innerHTML = d.backups.map(b => `
      <div class="note-item" style="padding:8px 12px;margin-bottom:6px">
        <div style="flex:1">
          <b style="font-size:13px">${esc(b.name)}</b>
          <div style="font-size:11px;color:var(--text-sub)">${b.files} 个文件</div>
        </div>
        <button class="btn small" data-restore="${esc(b.name)}">恢复此备份</button>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

if ($('#backupCreateBtn')) {
  $('#backupCreateBtn').addEventListener('click', async () => {
    const res = $('#backupResult');
    res.textContent = '正在备份…'; res.className = 'result';
    try {
      const d = await api('/api/backup/create', { method: 'POST' });
      res.textContent = `✅ 备份完成：${d.name}（${d.files} 个文件）`;
      res.className = 'result ok';
      loadBackupList();
    } catch (e) {
      res.textContent = '❌ ' + e.message;
      res.className = 'result err';
    }
  });
}
if ($('#backupRefreshBtn')) $('#backupRefreshBtn').addEventListener('click', loadBackupList);

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-restore]');
  if (!btn) return;
  const name = btn.dataset.restore;
  if (!confirm(`确定恢复备份「${name}」？当前数据将被覆盖！`)) return;
  const res = $('#backupResult');
  res.textContent = '正在恢复…'; res.className = 'result';
  try {
    const d = await api('/api/backup/restore', { method: 'POST', body: { name } });
    res.textContent = `✅ 已恢复 ${d.restored} 个文件，刷新页面生效`;
    res.className = 'result ok';
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    res.textContent = '❌ ' + e.message;
    res.className = 'result err';
  }
});

/* ============ v1.2.0：聊天历史面板事件绑定 ============ */
if ($('#chatHistoryBtn')) {
  $('#chatHistoryBtn').addEventListener('click', () => {
    const overlay = $('#chatHistoryOverlay');
    if (!overlay) return;
    overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
    if (overlay.style.display !== 'none') loadChatHistoryPanel();
  });
}
if ($('#chatHistoryClose')) {
  $('#chatHistoryClose').addEventListener('click', () => {
    $('#chatHistoryOverlay').style.display = 'none';
  });
}
if ($('#chatHistorySearch')) {
  $('#chatHistorySearch').addEventListener('input', debounce(loadChatHistoryPanel, 400));
}

/* ============ 手机端原生 App 级导航与折叠抽屉交互 (v1.1.9e) ============ */
const bottomMoreBtn = $('#bottomMoreBtn');
const moreSheet = $('#moreSheet');
const moreSheetBackdrop = $('#moreSheetBackdrop');

function openMoreSheet() {
  if (moreSheet && moreSheetBackdrop) {
    moreSheet.classList.add('open');
    moreSheetBackdrop.classList.add('open');
  }
}

function closeMoreSheet() {
  if (moreSheet && moreSheetBackdrop) {
    moreSheet.classList.remove('open');
    moreSheetBackdrop.classList.remove('open');
  }
}

if (bottomMoreBtn) bottomMoreBtn.addEventListener('click', openMoreSheet);
if (moreSheetBackdrop) moreSheetBackdrop.addEventListener('click', closeMoreSheet);

// 手机端底部金刚位与更多抽屉切换
$$('.bottom-tab-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
    closeMoreSheet();
  });
});

$$('.more-sheet-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
    closeMoreSheet();
  });
});

// 手机顶栏主题切换与同步绑定
if ($('#mobileThemeToggle')) {
  $('#mobileThemeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}
if ($('#mobileZenToggle')) {
  $('#mobileZenToggle').addEventListener('click', toggleZenMode);
}
if ($('#mobileSyncBadge')) {
  $('#mobileSyncBadge').addEventListener('click', () => {
    if ($('#syncBadge')) $('#syncBadge').click();
  });
}

// 移动端主题与同步状态由 applyTheme 与 updateSyncBadge 统一定向更新
