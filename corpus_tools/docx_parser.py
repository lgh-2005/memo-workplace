# -*- coding: utf-8 -*-
r"""docx exam parser for 英语一 past papers (原版 Word 题源, v2.6.0).

输入：整卷 .docx（Section/Part/Text 结构 + __N__ 挖空 + [ A ] 选项）。
输出：exam_norm 兼容的 items 列表。

分区映射（关键设计，v2.6.0 题源）：
  Section 1 (Use of English)          -> use_of_english : 整段正文一整块 passage(pid=1)
                                         + 20 题号 + 每题 4 选项
  Section 2 Part A (Text 1-4)         -> reading        : 每篇 Text 一块 passage(pid=N)
                                         + 题 21-40 挂 passage_id
  Section 2 Part B (新题型)           -> part_b         : 整块 passage(pid=1) + (A-G) 选项池
                                         + 41-45 五道空题（原文没有独立题号行，从 41..45 生成）
  Section 2 Part C (翻译 2005+)       -> translation    : 整块 passage(pid=1)（保留 (N) 哨兵）
                                         + 46-50 划线句拆题（从段落里按 (N)…(N+1) 截取）
  Section 3 (Writing)                 -> writing        : 51 小作文 / 52 大作文
  旧卷 1999-2004:
    1999 完形 10 题；2001-2004 完形 20 题。
    Section 2 Part A Text/Passage 1-5 -> reading（题号 11-40 连续，挂 passage_id）
    Section 2 Part B = 英译汉         -> translation（同上 (N) 哨兵，题号 41-45）
    Section 3                          -> writing（一道 36 题 / 或 51；旧卷 a/b/c 三点说明）
"""
import re
import zipfile

# ---------------- docx → paragraphs ----------------

def docx_paras(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'replace')
    out = []
    for pm in re.finditer(r'<w:p[ >].*?</w:p>', xml, re.S):
        texts = re.findall(r'<w:t(?: [^>]*)?>(.*?)</w:t>', pm.group(), re.S)
        line = ''.join(texts)
        line = (line.replace('&lt;', '<').replace('&gt;', '>')
                    .replace('&quot;', '"').replace('&apos;', "'")
                    .replace('&amp;', '&'))
        t = line.strip()
        if t:
            out.append(t)
    return out

# ---------------- regexes ----------------

RE_SEC = re.compile(r'^Section\s+([IＩ]+)\b', re.I)
RE_PART = re.compile(r'^Part\s+([A-C])\b', re.I)
RE_TEXT = re.compile(r'^(?:Text|Passage)\s+(One|Two|Three|Four|Five|[1-5])\b', re.I)
RE_QNUM = re.compile(r'^\s*(\d{1,2})\s*[\.．、]?\s*$|^\s*(\d{1,2})\s*[\.．、]\s*\[\s*[A-D]', re.I)
RE_QNUM2 = re.compile(r'^\s*(\d{1,2})\s*[\.．、]\s*(.*)$', re.S)
RE_SOLO = re.compile(r'^\s*(\d{1,2})\s*[\.．、]\s*$')
RE_OPT = re.compile(r'^\[?\s*[\[［(【]?\s*([A-D])\s*[\]）)】]?\s*\]?\s*(.+)$', re.S)
RE_INLINE = re.compile(r'[\[〔(（]\s*(\d{2})\s*[)）】〕\]]')
RE_PTS = re.compile(r'[（(]\s*(\d{1,2})\s*(?:points|分)\s*[）)]', re.I)

WORDNUM = {'One': 1, 'Two': 2, 'Three': 3, 'Four': 4, 'Five': 5}
ROMANNUM = {'I': 1, 'II': 2, 'III': 3}


def sec_no(s):
    m = RE_SEC.match(s)
    if not m:
        return None
    rom = m.group(1).upper().replace('Ｉ', 'I')
    n = ROMANNUM.get(rom, 0)
    return n or rom.count('I')


# ---------------- helpers ----------------

def _mk_passage(year, section, text, pid=None, title=None):
    d = {'year': year, 'type': 'passage', 'src': 'docx2026',
         'section': section, 'text': text, 'passage_id': pid}
    if title:
        d['title'] = title
    return d


def _mk_question(year, section, number, text, options=None, pid=None):
    return {'year': year, 'type': 'question', 'src': 'docx2026',
            'section': section, 'number': number, 'text': text,
            'options': options, 'passage_id': pid}


class _Ctx:
    def __init__(self):
        self.sec = None        # 1 / 2 / 3
        self.part = None       # A / B / C
        self.sec_name = None   # 'use_of_english' 等
        self.text_idx = 0
        self.buf = []          # 累积正文
        self.cur = None        # 当前题目 (number, stem, [(L,body)...])
        self.pool = {}         # Part B 选项池 {A:.., G:..}
        self.is_old = False    # 旧卷(<2005)：Part B = 英译汉

    def flush_buf(self, into_items, year):
        if not self.buf:
            return
        # 合并为一段（删除换行分隔，避免截段断裂）
        text = ' '.join(x for x in self.buf).strip()
        self.buf = []
        if not text:
            return
        # 通用清洗：剥掉混入正文的 Directions 说明与 "For each numbered blank..." 模板句
        m = re.search(r'Choose the best (?:one|word)', text)
        if m and m.start() < 400:
            # 找到该句结束的句号
            endm = re.search(r'\.\s*', text[m.end():])
            if endm:
                text = text[m.end() + endm.end():].strip()
        text = re.sub(r'^\s*\(\s*\d+\s*points?\s*\)\s*', '', text)  # 残留分值标注
        text = re.sub(r'^Directions:\s*', '', text)
        text = re.sub(r'^For each numbered blank[^.]*\.\s*', '', text)
        text = re.sub(r'^Read the following text[.。][^.]*\.\s*', '', text)
        if not text:
            return
        if self.sec == 1:
            into_items.append(_mk_passage(year, 'use_of_english', text, pid=1))
        elif self.sec == 2 and self.part == 'A':
            # Directions 行（卷首说明）不作为文章正文：
            if (text.startswith('Read the following')
                    or text.startswith('Directions:')
                    or text.startswith('Each of the passages')):
                return
            if self.text_idx:
                into_items.append(_mk_passage(year, 'reading', text, pid=self.text_idx))
            else:
                into_items.append(_mk_passage(year, 'reading', text))
        elif self.sec == 2 and self.part == 'B':
            into_items.append(_mk_passage(year, self.sec_name, text, pid=1))
        elif self.sec == 2 and self.part == 'C':
            into_items.append(_mk_passage(year, 'translation', text, pid=1))

    def flush_pool(self, into_items, year):
        """Part B 新题型：把 (A-G) 选项池追加为一道 (A-G options pool) 题。"""
        if self.sec == 2 and self.part == 'B' and not self.is_old and self.pool:
            into_items.append(_mk_question(year, 'part_b', None,
                                           '(A-G options pool)',
                                           options=dict(self.pool), pid=1))
            self.pool = {}

    def flush_q(self, into_items, year):
        self.flush_pool(into_items, year)
        if self.cur is None:
            return
        number, stem, opts = self.cur
        self.cur = None
        sect = self.sec_name
        pid = None
        if sect == 'reading':
            pid = self.text_idx if self.text_idx else None
        if sect == 'part_b' and (not stem or 'Part B' in stem):
            stem = f'(Part B 第 {number} 空)'
        if sect == 'use_of_english' and not stem:
            stem = f'(blank {number})'
        into_items.append(_mk_question(year, sect, number, stem,
                                       options=(dict(opts) if opts else None), pid=pid))

    def new_q(self, number, stem=None):
        self.cur = (number, stem or '', [])

    def add_opt(self, L, body):
        if self.cur is None:
            self.pool[L] = body
            return
        self.cur[2].append((L, body))


def parse_year(year, paras):
    """解析一整卷段落 → items（未 normalize）。"""
    st = _Ctx()
    st.is_old = year < 2005
    oldpb_cloze_qnums = set()   # 旧卷 Section II Part B 内嵌翻译题号
    items = []
    for s in paras:
        n_sec = sec_no(s)
        if n_sec in (1, 2, 3):
            st.flush_buf(items, year)
            st.flush_q(items, year)
            st = _Ctx()
            st.is_old = year < 2005
            st.sec = n_sec
            st.sec_name = {1: 'use_of_english',
                           2: None, 3: 'writing'}[n_sec]
            continue
        pp = RE_PART.match(s)
        if pp:
            st.flush_buf(items, year)
            st.flush_q(items, year)
            st.part = pp.group(1).upper()
            if st.sec == 2:
                if st.part == 'A':
                    st.sec_name = 'reading'
                elif st.part == 'B':
                    st.sec_name = 'translation' if st.is_old else 'part_b'
                else:
                    st.sec_name = 'translation'
            else:
                st.sec_name = 'writing'
            continue
        tm = RE_TEXT.match(s)
        if tm and st.sec == 2 and st.part == 'A':
            st.flush_buf(items, year)
            st.flush_q(items, year)
            w = tm.group(1)
            st.text_idx = WORDNUM.get(w, (int(w) if w.isdigit() else 0))
            continue

        # --- Section 3 (Writing) ---
        if st.sec == 3:
            m2 = re.match(r'^\s*(\d{2})\s*[\.．、]\s*(.*)$', s)
            if m2:
                n = int(m2.group(1))
                if n in (36, 46, 50, 51, 52):
                    st.flush_q(items, year)
                    st.new_q(n, m2.group(2))
                    continue
            # 正文行并入当前写作题
            if st.cur is not None:
                number, stem, opts = st.cur
                stem = (stem + '\n' + s) if stem else s
                st.cur = (number, stem, opts)
            else:
                st.buf.append(s)
            continue

        # --- Section 2 ---
        if st.sec == 2:
            m2 = re.match(r'^\s*(\d{2})\s*[\.．、]\s*(.*)$', s)
            if m2:
                n = int(m2.group(1))
                if n and 10 <= n <= 52:
                    st.flush_buf(items, year)
                    st.flush_q(items, year)
                    st.new_q(n, m2.group(2))
                    continue
            # Part B 新题型答题框行："（41) （42) ... （44) E （45)"
            if st.part == 'B' and not st.is_old and not st.cur and len(st.buf) == 0:
                nums = RE_INLINE.findall(s)
                if nums and sum(1 for x in nums if 41 <= int(x) <= 45) >= 2:
                    continue   # 忽略该行（题目稍后生成）
            L, body = _opt_of(s)
            if L and body:
                if st.part in ('A', 'B') and st.cur is not None:
                    st.cur[2].append((L, body))
                elif st.part == 'B' and st.cur is None:
                    st.pool[L] = body    # Part B 选项池
                continue
            # Part A Directions 行不放当作正文
            if st.part == 'A' and not st.text_idx and s.startswith('Read the following'):
                continue
            st.buf.append(s)
            continue

        # --- Section 1 ---
        if st.sec == 1:
            m2 = re.match(r'^\s*(\d{1,2})\s*[\.．、]\s*(.*)$', s)
            if m2:
                n = int(m2.group(1))
                if 1 <= n <= 25:
                    st.flush_buf(items, year)
                    st.flush_q(items, year)
                    st.new_q(n, m2.group(2))
                    continue
            L, body = _opt_of(s)
            if L and body and st.cur is not None:
                st.cur[2].append((L, body))
                continue
            st.buf.append(s)
            continue

        # PRE
        st.buf.append(s)

    st.flush_buf(items, year)
    st.flush_q(items, year)

    items = _postprocess(year, items)
    return items


_OPT_PATTERNS = [
    re.compile(r'^\(\s*([A-H])\s*\)\s+(.+)$'),            # (A) xxx
    re.compile(r'^[\[［【]\s*([A-H])\s*[\]］】]\s*(.+)$'),  # [ A ] / ［A］ / 【A】
    re.compile(r'^([A-H])\s*[\.．、]\s+(.+)$'),            # A. xx / A．xx / A、xx
    re.compile(r'^([A-H])\s*[:：]\s+(.+)$'),               # A: xx
]


def _opt_of(s):
    """严格匹配选项行（A–H，Part B 选项池可达 8 项）；防把正文句 "A parallel …" 误判为选项。"""
    for pat in _OPT_PATTERNS:
        m = pat.match(s)
        if m:
            L = m.group(1).upper()
            body = (m.group(2) or '').strip()
            if L in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H') and body:
                return L, body
    return None, None


def _postprocess(year, items):
    is_old = year < 2005
    # ---- part_b (新卷 only): 41-45 空题补齐 ----
    if not is_old:
        nums = sorted(it['number'] for it in items
                      if it['type'] == 'question' and it['section'] == 'part_b' and it['number'])
        have = set(nums)
        for n in range(41, 46):
            if n in have:
                continue
            items.append(_mk_question(year, 'part_b', n, f'(Part B 第 {n} 空)',
                                      options=None, pid=1))

    # ---- translation: 从 passage 里拆题 ----
    tr_pass = [it for it in items if it['type'] == 'passage' and it['section'] == 'translation']
    tr_qs = [it for it in items if it['type'] == 'question' and it['section'] == 'translation']
    if tr_pass and (not tr_qs or all(len(q.get('text') or '') < 12 for q in tr_qs)):
        full = ' '.join(ix['text'] for ix in tr_pass)
        full = re.sub(r'\s+', ' ', full)
        # 剔除 Directions 混入正文
        full = re.sub(r'^Directions:\s*', '', full)
        full = re.sub(r'^Read the following text carefully[^.]*\.\s*', '', full)
        marks = [(int(m.group(1)), m) for m in RE_INLINE.finditer(full)
                 if 20 <= int(m.group(1)) <= 52]
        existing = {q['number'] for q in tr_qs if q.get('number')}
        # 期望题号：新卷 46-50；旧卷按实际哨兵号（1999=31-35，2000=36-40 等）
        want = set(range(46, 51)) if not is_old else None
        cand = []
        for idx, (n, m) in enumerate(marks):
            if want is not None and n not in want:
                continue
            if want is None and (n < 21 or n > 45):
                continue
            cand.append((n, m))
        for idx, (n, m) in enumerate(cand):
            if n in existing:
                continue
            start = m.end()
            end = cand[idx + 1][1].start() if idx + 1 < len(cand) else len(full)
            seg = full[start:end]
            cut = re.search(r'(Section\s+[IＩ]+|Directions:)', seg)
            if cut and cut.start() > 20:
                seg = seg[:cut.start()]
            seg = re.sub(r'\s+', ' ', seg).strip(' ,;:')
            if not seg:
                continue
            items.append(_mk_question(year, 'translation', n, seg, pid=1))
    return items


def summarize_quick(items):
    from collections import Counter
    c = Counter((x['section'], x['type']) for x in items)
    return dict(c)
