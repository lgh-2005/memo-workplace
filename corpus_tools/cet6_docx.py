# -*- coding: utf-8 -*-
r"""CET-6 (六级) whole-paper docx parser (v2.7.1).

输入：整卷 .docx（Part I–IV + Section A/B/C 结构，2015–2026 各版式）
输出：与 server.js buildUnits() 兼容的 items 列表（track=cet6）。

板块映射（六级卷面 → 站点 section）：
  Part I  Writing                     -> writing        : 1 道作文（开篇句/图表/名言）
  Part II Listening Comprehension     -> listening      : 25 题；每段录音一块 passage(pid)
  Part III Section A 选词填空 26-35    -> banked_cloze   : 原文(〖26〗..〖35〗) + 15 词选项池
  Part III Section B 长篇匹配 36-45    -> long_match     : A)~O) 段落正文 + 10 条陈述
  Part III Section C 仔细阅读 46-55    -> reading        : Passage One/Two + 各 5 题
  Part IV Translation                 -> translation    : 整段中文 + 1 道书写题

「本部分与 X 卷共用」的板块留空（按用户决策，不入正文）。
"""
import re
import zipfile

ROMANNUM = {'I': 1, 'II': 2, 'III': 3, 'IV': 4}
WORDNUM = {'One': 1, 'Two': 2, 'Three': 3, 'Four': 4}

RE_PART = re.compile(r'^Part\s+([IV]+)\b', re.I)
RE_SEC = re.compile(r'^Section\s+([ABC])\b', re.I)
RE_QGROUP = re.compile(r'^Questions?\s+(\d{1,2})\s+to\s+(\d{1,2})\b', re.I)
RE_PASSAGE = re.compile(r'^Passage\s+(One|Two|Three|Four)\b', re.I)
RE_QNUM = re.compile(r'^\s*(\d{1,2})\s*[\.．、]\s*(.*)$', re.S)
RE_OPT_PAREN = re.compile(r'^\s*([A-O])\s*[\)）]\s*(.+)$', re.S)
RE_OPT_DOT = re.compile(r'^\s*([A-O])\s*[\.．、]\s*(.+)$', re.S)
RE_BANK_BARE = re.compile(r'^\s*([A-O])\s+(?!\([A-Z])([A-Za-z][A-Za-z\-\']*)\s*$')
RE_SHARED = re.compile(r'^本部分与.*共用')


def docx_paras(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'replace')
    out = []
    for pm in re.finditer(r'<w:p[ >].*?</w:p>', xml, re.S):
        texts = re.findall(r'<w:t(?: [^>]*)?>(.*?)</w:t>', pm.group(), re.S)
        line = ''.join(texts)
        for a, b in (('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'),
                     ('&apos;', "'"), ('&amp;', '&')):
            line = line.replace(a, b)
        t = line.strip()
        if t:
            out.append(t)
    return out


def part_no(s):
    m = RE_PART.match(s)
    return ROMANNUM.get(m.group(1).upper().replace('Ｉ', 'I')) if m else None


def _opt_of(s):
    m = RE_OPT_PAREN.match(s)
    if m:
        return m.group(1).upper(), m.group(2).strip()
    m = RE_OPT_DOT.match(s)
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, None


def _bank_of(s):
    """选词填空词池行：`A) allev iate` / `A. alleviate` / `A alleviate`（裸空格）。"""
    m = RE_OPT_PAREN.match(s) or RE_OPT_DOT.match(s)
    if m:
        return m.group(1).upper(), m.group(2).strip()
    m = RE_BANK_BARE.match(s)
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, None


def _word_of(s):
    """选词填空 A–O 词池行：单字母 + 单个英文词（A) x / A. x / A x）。"""
    L, w = _bank_of(s)
    if L and w and len(w) < 26 and re.fullmatch(r"[A-Za-z][A-Za-z'\-]*", w):
        return L, w
    return None, None


RE_UNDER = re.compile(r'_{2,}\s*\(?\s*(\d{2})\s*\)?\s*_{2,}')


def _blanks(s):
    """`__26__` / `__(26)__` → `〖26〗`（与考研完形一致的内联挖空标记）。"""
    return RE_UNDER.sub(lambda m: f'〖{m.group(1)}〗', s)


class _P:
    """单卷解析状态。"""
    def __init__(self, year):
        self.year = year
        self.part = None
        self.sec = None
        self.pid = 0
        self.buf = []
        self.cur = None          # (number, stem, [(L, body)])
        self.bank = {}           # 选词填空 A–O 词池
        self.bank_lines = []     # 选词填空整节原始行（离节时统一拆分）
        self.paras_pool = []     # 长篇匹配 A)~O) 段落
        self.items = []

    def mk(self, sec, **kw):
        d = {'year': self.year, 'src': 'cet6-docx', 'section': sec}
        d.update(kw)
        return d

    def flush_buf(self):
        text = '\n'.join(x for x in self.buf).strip()
        self.buf = []
        if not text:
            return
        if self.sec == 'translation':
            self.items.append(self.mk('translation', type='passage', text=text, passage_id=1))
        elif self.sec == 'reading':
            self.items.append(self.mk('reading', type='passage', text=text, passage_id=self.pid or 1))
        elif self.sec == 'long_match':
            self.paras_pool.append(('T', text))
        elif self.sec == 'writing':
            self.emit_writing(text)

    def flush_q(self):
        if self.cur is None:
            return
        number, stem, opts = self.cur
        self.cur = None
        if self.sec == 'listening':
            self.items.append(self.mk('listening', type='question', number=number, text='',
                                      options=dict(opts) or None, passage_id=self.pid or 1))
        elif self.sec == 'reading':
            self.items.append(self.mk('reading', type='question', number=number, text=stem,
                                      options=dict(opts) or None, passage_id=self.pid or 1))
        elif self.sec == 'writing':
            self.emit_writing(stem)

    def emit_writing(self, text):
        if text and text.strip():
            # 六级卷面题号：写作位于翻译(56)之后，用 57 以免与听力 1 冲突
            self.items.append(self.mk('writing', type='writing', number=57, part='A', text=text.strip()))

    def _close_banked_cloze(self):
        """离开选词填空板块时，拆分「正文」与「A–O 词池」并展开 26–35 题。"""
        lines = self.bank_lines
        self.bank_lines = []
        if not lines:
            return
        pool, body = {}, []
        for raw in lines:
            L, w = _word_of(raw)
            # 词池行：单字母 + 单个英文词（无句读、无空格连接的多词）
            if L and w and len(w) < 26 and re.fullmatch(r"[A-Za-z][A-Za-z'\-]*", w):
                pool[L] = w
            elif raw.startswith('Directions'):
                continue
            else:
                body.append(_blanks(raw))
        # 词池须基本完整（A–O 15 项）才认定；否则视为误判，正文照收
        if len(pool) >= 10:
            self.bank = pool
            self.items.append(self.mk('banked_cloze', type='passage', passage_id=1,
                                      text='\n'.join(body).strip()))
            for n in range(26, 36):
                self.items.append(self.mk('banked_cloze', type='question', number=n, text='',
                                          options=dict(pool), passage_id=1))
        elif body:
            self.items.append(self.mk('banked_cloze', type='passage', passage_id=1,
                                      text='\n'.join(body).strip()))

    def start_part(self, pn):
        self.flush_buf(); self.flush_q(); self._close_banked_cloze()
        self.part = pn
        self.pid = 0
        self.bank = {}
        self.bank_lines = []
        self.paras_pool = []
        self.sec = {1: 'writing', 2: 'listening', 3: None, 4: 'translation'}.get(pn)

    def start_sec(self, letter):
        self.flush_buf(); self.flush_q(); self._close_banked_cloze()
        if self.part == 2:
            # 听力 Section A/B/C 是连续录音流，pid 不重置（否则段落会串号）
            self.sec = 'listening'
        elif self.part == 3:
            self.pid = 0
            self.sec = {'A': 'banked_cloze', 'B': 'long_match', 'C': 'reading'}[letter]
            self.bank = {}
            self.bank_lines = []
            self.paras_pool = []


def parse_paper(year, month, setno, paras):
    P = _P(year)
    for raw in paras:
        if RE_SHARED.search(raw):
            continue
        pn = part_no(raw)
        if pn:
            P.start_part(pn)
            continue
        sm = RE_SEC.match(raw)
        if sm and P.part in (2, 3):
            P.start_sec(sm.group(1).upper())
            continue

        sec = P.sec

        if sec == 'listening':
            gm = RE_QGROUP.match(raw)
            if gm:
                P.flush_q()
                P.pid += 1
                a, b = int(gm.group(1)), int(gm.group(2))
                P.items.append(P.mk('listening', type='passage', passage_id=P.pid,
                                    text=f'（听力录音 {a}–{b} 题·暂无本地音频）'))
                continue
            qm = RE_QNUM.match(raw)
            if qm and 1 <= int(qm.group(1)) <= 25:
                P.flush_q()
                P.cur = (int(qm.group(1)), '', [])
                continue
            L, body = _opt_of(raw)
            if L and P.cur is not None:
                P.cur[2].append((L, body))
                continue
            continue

        if sec == 'banked_cloze':
            P.bank_lines.append(raw)
            continue

        if sec == 'long_match':
            qm = RE_QNUM.match(raw)
            if qm and 36 <= int(qm.group(1)) <= 45:
                P.flush_buf()
                P.items.append(P.mk('long_match', type='question', number=int(qm.group(1)),
                                    text=qm.group(2).strip(), options=None, passage_id=1))
                continue
            m = RE_OPT_PAREN.match(raw)
            if m:
                P.flush_buf()
                P.paras_pool.append((m.group(1).upper(), m.group(2).strip()))
                continue
            P.buf.append(raw)
            continue

        if sec == 'reading':
            pm = RE_PASSAGE.match(raw)
            if pm:
                P.flush_buf(); P.flush_q()
                P.pid = WORDNUM.get(pm.group(1), 1)
                continue
            if RE_QGROUP.match(raw):
                P.flush_q()
                continue
            qm = RE_QNUM.match(raw)
            if qm and 46 <= int(qm.group(1)) <= 55:
                P.flush_buf(); P.flush_q()
                P.cur = (int(qm.group(1)), qm.group(2).strip(), [])
                continue
            L, body = _opt_of(raw)
            if L and P.cur is not None:
                P.cur[2].append((L, body))
                continue
            if raw.startswith('Directions'):
                continue
            if P.cur is None:
                P.buf.append(raw)
            continue

        if sec == 'writing':
            if raw.startswith('Directions'):
                P.buf.append(re.sub(r'^Directions:\s*', '', raw))
            elif P.buf:
                P.buf.append(raw)
            else:
                P.buf.append(raw)
            continue

        if sec == 'translation':
            if not raw.startswith('Directions'):
                P.buf.append(raw)
            continue

        P.buf.append(raw)

    P.flush_buf(); P.flush_q(); P._close_banked_cloze()

    # 长篇匹配：段落正文合并为一块 passage
    if P.paras_pool:
        body = '\n'.join(t if k == 'T' else f'{k}) {t}' for k, t in P.paras_pool)
        P.items.insert(0, P.mk('long_match', type='passage', passage_id=1, text=body))
    # 翻译：整段中文 passage + 1 道书写题（题号 56，避免与听力 1 冲突）
    if (any(it['section'] == 'translation' and it['type'] == 'passage' for it in P.items)
            and not any(it['section'] == 'translation' and it['type'] == 'question' for it in P.items)):
        P.items.append(P.mk('translation', type='question', number=56,
                            text='(英译段落)', options=None, passage_id=1))
    return P.items
