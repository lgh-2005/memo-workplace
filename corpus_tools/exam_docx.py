# -*- coding: utf-8 -*-
r"""考研英语（一）整卷 docx 解析器 v2 —— 2026-09 真题库重建。

设计目标：把「原版 Word 整卷」还原成 工作台真题库契约（exams.jsonl 的 qa_set.items），
严格按真实考题的 **卷面结构 + 答题逻辑** 落库，而不是制造占位符。

卷面结构（逐段状态机）：
  Section I  Use of English   -> section=use_of_english
      正文段落（含 __N__ 挖空）-> passage(pid=1)，挖空统一转 〖N〗 锚点
      行号 "1." + 4 行 "[ A ] ..." -> question(number=N, options, qtype=单选)
  Section II Reading Comprehension
      Part A  Text/Passage 1..N -> 每篇一块 passage(section=reading, pid=k)
               "21. 题干" + 选项行 -> question(section=reading, number, pid=当前篇)
      Part B  （新卷 2005+）     -> section=part_b
               正文含 (4N)______   -> passage(pid=1)，空位转 〖4N〗 锚点
               7 段 [ A ]-[ G ]     -> 选项池 question(number=None, options=A..G)
               排序题（无正文）      -> 选项池即正文段落，无 passage
               5 个空位 41-45       -> question(number=41..45)
      Part B/C（旧卷 <2005）    -> 英译汉，见 translation
      Part C  （新卷 2005+）     -> section=translation
               正文中「下划线 run」= 划线句 -> passage(pid=1)，转 〖N〗…〖/N〗
               划线句拆题 46-50            -> question(text=划线句)
  Section III Writing                -> section=writing
      Part A 51 / Part B 52（新卷）  -> writing(part=A/B, score=10/20)
      旧卷单篇 36./46.               -> writing(part=None, score=20)

答题逻辑（answerMode）：
  涂卡   —— 完形 / 阅读 / 新题型
  书写   —— 翻译
  作文纸 —— 写作
标准答案（answer）一律不臆造：留 null，由 data/answers.json 的权威录入通道维护。
"""
import re
import zipfile

SEC_ROMAN = {'I': 1, 'II': 2, 'III': 3}
ROMAN_WORD = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6}

RE_SEC = re.compile(r'^Section\s+(I{1,3})\b', re.I)
RE_PART = re.compile(r'^Part\s+([A-C])\b', re.I)
RE_TEXT = re.compile(r'^(?:Text|Passage)\s+(One|Two|Three|Four|Five|Six|[1-6])\b', re.I)
RE_QNUM_ONLY = re.compile(r'^\s*(\d{1,2})\s*[.．、]\s*$')
RE_QNUM_STEM = re.compile(r'^\s*(\d{1,2})\s*[.．、]\s+(\S.*)$')
RE_OPT = re.compile(r'^\s*\[\s*([A-H])\s*\]\s*(.*)$')
RE_OPT_ALT = re.compile(r'^\s*([A-H])\s*[.．、:：]\s+(\S.*)$')
RE_POOL_MARK = re.compile(r'^\s*\[\s*([A-H])\s*\]\s*(.*)$')
RE_BLANK_US = re.compile(r'_{2,}\s*(\d{1,2})\s*_{2,}')
RE_BLANK_PAREN = re.compile(r'[（(]\s*(\d{1,2})\s*[)）]\s*_{2,}')
RE_MARK_INLINE = re.compile(r'[（(]\s*(\d{1,2})\s*[)）]')
RE_POINTS = re.compile(r'[（(]\s*(\d{1,2})\s*(?:points?|分)\s*[)）]', re.I)
RE_BOXLINE = re.compile(r'[（(]\s*4[1-5]\s*[)）]')

DIRECTION_PREFIXES = (
    'directions', 'read the following', 'for each numbered blank',
    'for questions', 'each of the passages', 'in the following',
    'the following paragraphs', 'you are going to', 'write your answer',
    'write an essay', 'write a notice', 'suppose you are', 'you should write',
    'translate the', 'choose the most suitable', 'answer the questions',
)


def unescape(s):
    return (s.replace('&lt;', '<').replace('&gt;', '>')
             .replace('&quot;', '"').replace('&apos;', "'")
             .replace('&amp;', '&'))


def docx_runs(path):
    """docx -> [[(text, underlined), ...], ...]，保留不连续下划线信息。"""
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'replace')
    paras = []
    for pm in re.finditer(r'<w:p[ >].*?</w:p>', xml, re.S):
        p = pm.group()
        runs = []
        for rm in re.finditer(r'<w:r[ >].*?</w:r>', p, re.S):
            r = rm.group()
            rpr = re.search(r'<w:rPr>.*?</w:rPr>', r, re.S)
            rprs = rpr.group() if rpr else ''
            ts = re.findall(r'<w:t(?: [^>]*)?>(.*?)</w:t>', r, re.S)
            raw = ''.join(ts)
            if not raw:
                continue
            u = bool(re.search(r'<w:u(?: [^>]*)?/?>', rprs)) and 'w:val="none"' not in rprs
            runs.append((unescape(raw), u))
        if runs and ''.join(t for t, _ in runs).strip():
            paras.append(runs)
    return paras


def flat(runs):
    return ''.join(t for t, _ in runs)


def _is_direction(line):
    low = line.strip().lower()
    if not low:
        return True
    return any(low.startswith(p) for p in DIRECTION_PREFIXES)


def _opt_of(line):
    m = RE_OPT.match(line)
    if m and m.group(2).strip():
        return m.group(1).upper(), m.group(2).strip()
    m = RE_OPT_ALT.match(line)
    if m and m.group(2).strip():
        # 防止把正文 "A. Study ..." 或 "E. coli ..." 误判：要求字母独立、句体大写开头且非句子延续
        return m.group(1).upper(), m.group(2).strip()
    return None, None


# ---------------------------------------------------------------------------

class _Ctx:
    def __init__(self):
        self.sec = None
        self.part = None
        self.sec_name = None
        self.text_idx = 0
        self.buf = []          # [(runs, kind)]
        self.cur = None        # (number, stem, [(L, body)])
        self.pool = {}
        self.is_old = False
        self.pb_box = None     # Part B 排序题答题框（(41) → … → E → (45)）
        self.pb_dir = ''       # Part B Directions（用于判别题型）


def _passage(year, section, runs, pid=1):
    return {'year': year, 'type': 'passage', 'src': 'docx', 'section': section,
            'text': _render(runs, 'underline'), 'passage_id': pid}


def _render(runs, mode):
    """mode=underline: 下划线 run -> 〖N〗…〖/N〗；其余统一把挖空转 〖N〗。"""
    out = []
    i = 0
    n = len(runs)
    while i < n:
        t, u = runs[i]
        if mode == 'underline' and u:
            text = t
            i += 1
            while i < n and runs[i][1]:
                text += runs[i][0]
                i += 1
            m = RE_MARK_INLINE.search(text)
            text = RE_MARK_INLINE.sub('', text, count=1).strip() if m else text.strip()
            num = m.group(1) if m else ''
            out.append(f'〖{num}〗{text}〖/{num}〗')
            continue
        out.append(t)
        i += 1
    text = ''.join(out)
    text = RE_BLANK_US.sub(lambda m: f'〖{m.group(1)}〗', text)
    text = RE_BLANK_PAREN.sub(lambda m: f'〖{m.group(1)}〗', text)
    return re.sub(r'[ \t]+', ' ', text).strip()


def _flush_passage(st, year, items):
    if not st.buf:
        return
    kinds = {k for _, k in st.buf}
    mode = 'underline' if kinds == {'underline'} else 'blank'
    if kinds == {'underline'} or (kinds - {'body'} == {'underline'}):
        mode = 'underline'
    runs = []
    for r, _ in st.buf:
        runs.extend(r)
        runs.append(('\n\n', False))
    st.buf = []
    txt = _render(runs, mode)
    if not txt.strip():
        return
    if st.sec == 1:
        items.append(_passage(year, 'use_of_english', runs, pid=1))
    elif st.sec == 2 and st.part == 'A':
        if st.text_idx:
            items.append(_passage(year, 'reading', runs, pid=st.text_idx))
    elif st.sec == 2 and st.part == 'B':
        # 旧卷(<2005) Part B 即英译汉 -> translation；新卷为 Part B 新题型
        items.append(_passage(year, st.sec_name or 'part_b', runs, pid=1))
    elif st.sec == 2 and st.part == 'C':
        items.append(_passage(year, 'translation', runs, pid=1))


def _flush_pool(st, year, items):
    if st.sec == 2 and st.part == 'B' and not st.is_old and st.pool:
        items.append({'year': year, 'type': 'question', 'src': 'docx',
                      'section': 'part_b', 'number': None, 'text': '',
                      'options': dict(st.pool), 'passage_id': 1})
        st.pool = {}


def _flush_q(st, year, items):
    _flush_pool(st, year, items)
    if st.cur is None:
        return
    number, stem, opts = st.cur
    st.cur = None
    sect = st.sec_name
    if sect == 'writing':
        it = {'year': year, 'type': 'writing', 'src': 'docx', 'section': 'writing',
              'number': number, 'text': stem.strip(), 'part': st.part}
        items.append(it)
        return
    pid = None
    if sect == 'reading':
        pid = st.text_idx or None
    items.append({'year': year, 'type': 'question', 'src': 'docx', 'section': sect,
                  'number': number, 'text': stem.strip(),
                  'options': (dict(opts) if opts else None), 'passage_id': pid})


def parse_year(year, paras):
    st = _Ctx()
    st.is_old = year < 2005
    items = []
    for runs in paras:
        line = flat(runs)
        s = line.strip()
        if not s:
            continue

        m = RE_SEC.match(s)
        if m:
            _flush_passage(st, year, items)
            _flush_q(st, year, items)
            n = SEC_ROMAN[m.group(1).upper()]
            st = _Ctx()
            st.is_old = year < 2005
            st.sec = n
            st.sec_name = {1: 'use_of_english', 2: None, 3: 'writing'}[n]
            continue

        m = RE_PART.match(s)
        if m:
            _flush_passage(st, year, items)
            _flush_q(st, year, items)
            st.part = m.group(1).upper()
            if st.sec == 2:
                st.sec_name = {'A': 'reading', 'B': 'translation' if st.is_old else 'part_b',
                               'C': 'translation'}[st.part]
            else:
                st.sec_name = 'writing'
            continue

        m = RE_TEXT.match(s)
        if m and st.sec == 2 and st.part == 'A':
            _flush_passage(st, year, items)
            _flush_q(st, year, items)
            w = m.group(1)
            st.text_idx = ROMAN_WORD.get(w.lower(), int(w) if w.isdigit() else st.text_idx + 1)
            continue

        # ---------------- Section III：写作 ----------------
        if st.sec == 3:
            m2 = re.match(r'^\s*(\d{1,2})\s*[.．、]\s*(.*)$', s)
            if m2 and int(m2.group(1)) in (36, 46, 50, 51, 52):
                _flush_q(st, year, items)
                st.cur = (int(m2.group(1)), m2.group(2), [])
                continue
            if st.cur is not None:
                num, stem, opts = st.cur
                st.cur = (num, (stem + '\n' + s) if stem else s, opts)
            continue

        # ---------------- Section II ----------------
        if st.sec == 2:
            if st.part == 'B' and not st.is_old and RE_BOXLINE.search(s) and \
                    (len(RE_MARK_INLINE.findall(s)) >= 2 or '→' in s or '->' in s):
                # 排序题答题框：把 (41) → … → E → (45) 保留为答题骨架
                _flush_passage(st, year, items)
                _flush_pool(st, year, items)
                skel = re.sub(r'\s*(?:→|->)\s*', ' → ', s).strip()
                skel = RE_MARK_INLINE.sub(lambda m: f'〖{m.group(1)}〗', skel)
                items.append({'year': year, 'type': 'passage', 'src': 'docx',
                              'section': 'part_b', 'text': skel, 'passage_id': 1})
                continue
            m2 = RE_QNUM_STEM.match(s)
            if m2 and 10 <= int(m2.group(1)) <= 52 and not _is_direction(s):
                _flush_passage(st, year, items)
                _flush_q(st, year, items)
                st.cur = (int(m2.group(1)), m2.group(2), [])
                continue
            L, body = _opt_of(s)
            if L and body is not None:
                if st.part in ('A',) and st.cur is not None:
                    st.cur[2].append((L, body))
                elif st.part == 'B' and not st.is_old and st.cur is None:
                    st.pool[L] = body
                elif st.cur is not None and st.part == 'A':
                    st.cur[2].append((L, body))
                continue
            if _is_direction(s):
                continue
            if st.part == 'A' and not st.text_idx:
                continue
            st.buf.append((runs, 'underline' if st.sec_name == 'translation' else 'body'))
            continue

        # ---------------- Section I：完形 ----------------
        if st.sec == 1:
            m2 = re.match(r'^\s*(\d{1,2})\s*[.．、]\s*(.*)$', s)
            if m2 and 1 <= int(m2.group(1)) <= 25:
                _flush_passage(st, year, items)
                _flush_q(st, year, items)
                st.cur = (int(m2.group(1)), m2.group(2), [])
                continue
            L, body = _opt_of(s)
            if L and st.cur is not None:
                st.cur[2].append((L, body))
                continue
            if _is_direction(s):
                continue
            st.buf.append((runs, 'body'))
            continue

    _flush_passage(st, year, items)
    _flush_q(st, year, items)
    items = _postprocess(year, items)
    return items


def _postprocess(year, items):
    is_old = year < 2005
    if not is_old:
        have = {it['number'] for it in items
                if it['type'] == 'question' and it['section'] == 'part_b' and it.get('number')}
        for n in range(41, 46):
            if n not in have:
                items.append({'year': year, 'type': 'question', 'src': 'docx',
                              'section': 'part_b', 'number': n, 'text': '',
                              'options': None, 'passage_id': 1})
    # 翻译：从 passage 的 〖N〗…〖/N〗 中拆出划线句
    tr_pass = [it for it in items if it['type'] == 'passage' and it['section'] == 'translation']
    tr_qs = [it for it in items if it['type'] == 'question' and it['section'] == 'translation']
    if tr_pass and not tr_qs:
        full = ' '.join(x['text'] for x in tr_pass)
        for m in re.finditer(r'〖(\d{1,2})〗(.*?)〖/\1〗', full, re.S):
            n = int(m.group(1))
            seg = re.sub(r'\s+', ' ', m.group(2)).strip()
            if seg:
                items.append({'year': year, 'type': 'question', 'src': 'docx',
                              'section': 'translation', 'number': n, 'text': seg,
                              'options': None, 'passage_id': 1})
    return items


# ---------------------------------------------------------------------------

SECTION_RULES = {'use_of_english': (10, '单选', '涂卡'),
                 'reading': (40, '单选', '涂卡'),
                 'part_b': (10, '匹配', '涂卡'),
                 'translation': (10, '解答', '书写')}


def normalize(items, year=0):
    from collections import Counter
    counts = Counter(x.get('section') for x in items if x['type'] == 'question'
                     and x.get('number') is not None)
    for it in items:
        if it['type'] == 'passage':
            continue
        sec = it.get('section')
        if it['type'] == 'writing':
            it['qtype'] = '作文'
            it['answerMode'] = '作文纸'
            m = RE_POINTS.search(it.get('text') or '')
            if m:
                it['score'] = int(m.group(1))
            elif it.get('part'):
                it['score'] = {'A': 10, 'B': 20}.get(it['part'], 20)
            else:
                # 旧卷单篇作文：1999/2000 为 15 分，2001 起 20 分
                it['score'] = 15 if (it.get('year') or year) <= 2000 else 20
            it['answer'] = None
            continue
        total, qt, mode = SECTION_RULES.get(sec, (None, '解答', '书写'))
        it['qtype'] = qt
        it['answerMode'] = mode
        it['answer'] = None
        if it.get('number') is None:
            it['score'] = None        # 选项池/非题条目不计分
            continue
        n = counts.get(sec, 0)
        it['score'] = round(total / n, 2) if total and n else None
    return _order(items)


def _order(items):
    """板块顺序：完形 -> 阅读 -> 新题型 -> 翻译 -> 写作；板块内正文在前、题目按号。"""
    order = ['use_of_english', 'reading', 'part_b', 'translation', 'writing']
    out = []
    for sec in order:
        grp = [it for it in items if it.get('section') == sec]
        corpus = [it for it in grp if it['type'] != 'question']
        qs = [it for it in grp if it['type'] == 'question']
        qs.sort(key=lambda x: (x.get('passage_id') or 0, x.get('number') if x.get('number') is not None else 0))
        out.extend(corpus)
        out.extend(qs)
    extra = [it for it in items if it.get('section') not in order]
    return out + extra


def summarize(items):
    from collections import Counter
    qs = [x for x in items if x['type'] == 'question']
    return {'questions': len(qs),
            'by_qtype': dict(Counter(x['qtype'] for x in qs)),
            'total_score': sum(x.get('score') or 0 for x in qs) or None}
