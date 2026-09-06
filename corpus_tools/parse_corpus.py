# -*- coding: utf-8 -*-
"""Parse raw exam text -> structured corpus (JSONL + index).

English One layout: cloze Q1-20, reading A Q21-40, part B Q41-45,
translation C Q46-50, writing Q51-52.
Degrades gracefully: sections that fail to parse are stored raw.
"""
import json, os, re, glob

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "data", "raw_text")
OUT = os.path.join(BASE, "data")

SECTION_PATTERNS = [
    ("use_of_english", re.compile(r"use\s*of\s*english", re.I)),
    ("reading", re.compile(r"reading\s*comprehension|section\s*(II|Ⅱ|Il|ll)\b", re.I)),
    ("writing", re.compile(r"(?i)section\s*(?:III|Ⅲ|m|IlI|IIl)\s*writing")),
]

def norm(t):
    t = t.replace("<<<PAGE>>>", "\n")
    for i, r in [("Ⅰ", "I"), ("Ⅱ", "II"), ("Ⅲ", "III"), ("Ⅳ", "IV")]:
        t = t.replace(i, r)
    t = t.replace("\u00a0", " ")
    return t

def split_sections(t):
    """Find section boundaries by keyword positions."""
    marks = []
    for kind, pat in SECTION_PATTERNS:
        for m in pat.finditer(t):
            marks.append((m.start(), kind))
    marks.sort()
    bounds, picked = [], set()
    for pos, kind in marks:
        if kind in picked:
            continue
        picked.add(kind)
        bounds.append((pos, kind))
        if len(picked) == 3:
            break
    if not bounds:
        return {"unknown": t}
    secs, order = {}, ["use_of_english", "reading", "writing"]
    for i, (pos, kind) in enumerate(bounds):
        end = bounds[i + 1][0] if i + 1 < len(bounds) else len(t)
        secs[kind] = t[pos:end]
    first = bounds[0][0]
    if first > 200:
        secs["cover"] = t[:first]
    return secs

BOUNDARY = re.compile(r"(?m)^\s*Text\s*(One|Two|Three|Four|[1-4])\b|^\s*[Pp]art\s*[A-C]\b|^\s*Directions", re.I)
QNUM = re.compile(r"(?m)^\s*(\d{1,2})\s*[\.．、]\s*")
OPT = re.compile(r"\[([A-G])(?:\]|J)")  # ] may be glyph-damaged to J

def parse_abc_d_options(region):
    """2023-style cloze options: per-question rows 'N. A. x / B. y / C. z',
    with D options in a separate contiguous column afterwards."""
    rows = list(re.finditer(r"(?m)^\s*(\d{1,2})\s*[\.．]\s*A[\.．]\s*(.*)$", region))
    if len(rows) < 10:
        return {}
    out = {}
    for i, m in enumerate(rows):
        num = int(m.group(1))
        seg = region[m.end(): rows[i + 1].start() if i + 1 < len(rows) else len(region)]
        opts = {"A": clean(m.group(2))}
        for L in "BCD":
            lm = re.search(rf"(?m)^\s*{L}[\.．]\s*(.*)$", seg)
            if lm:
                opts[L] = clean(lm.group(1))
        if len(opts) >= 3:
            out[num] = opts
    all_d = [clean(m.group(1)) for m in re.finditer(r"(?m)^\s*D[\.．]\s*(.*)$", region)]
    all_d = [d for d in all_d if d]
    dlist, run = [], []
    for d in all_d + [None]:
        if d is not None and len(d) < 40:
            run.append(d)
        else:
            if len(run) > len(dlist):
                dlist = run
            run = []
    nums = sorted(out)
    if len(dlist) >= len(nums):
        for k, num in enumerate(nums):
            if k < 20:
                out[num]["D"] = dlist[k]
    return {n: o for n, o in out.items() if len(o) >= 4}

def parse_column_options(region):
    """Reconstruct cloze options from column layout.

    Text-layer PDFs print option columns: [A] q1..q4, [B] q1..q4, ...,
    where [A] tokens may carry question numbers. The k-th token of each
    letter maps to the k-th question (calibrated by numbered anchors).
    """
    toks = re.findall(r"\[([A-D])\]\s*([^\[]{1,90}?)\s*(?=\d{1,2}\s*[\.．]|\[[A-D]\]|$)",
                      region, re.M)
    groups = {}
    for letter, text in toks:
        groups.setdefault(letter, []).append(clean(text))
    if not groups.get("A"):
        return {}
    anchors = re.findall(r"(?m)^\s*(\d{1,2})\s*[\.．]\s*\[A\]", region)
    n = len(groups["A"])
    out = {}
    for k in range(n):
        q = int(anchors[k]) if k < len(anchors) and k == n - len(anchors) + k else k + 1
        opts = {L: groups[L][k] for L in "ABCD" if k < len(groups.get(L, []))}
        if len(opts) >= 4:
            out[q] = opts
    return out

def cut_body(block):
    """Question text = content before the first option marker."""
    m = re.search(r"\[[A-G]\]|^\s*[A-G]\s*[\.．、]", block, re.M)
    return block[:m.start()].strip() if m else block.strip()

def extract_options(block):
    """Bracket style first ([A] x), fallback to line style (A. x)."""
    parts = OPT.split(block)
    opts = {}
    for i in range(1, len(parts) - 1, 2):
        letter, text = parts[i], parts[i + 1].strip(" \n.、")
        text = WATERMARK.sub(" ", text)
        text = re.split(r"[\u4e00-\u9fff]", text)[0]
        text = re.sub(r"\s*[\.．]?\s*\d{1,2}\s*[\.．]\s*$", "", text)
        text = re.sub(r"\s+", " ", text)[:150]
        if len(text) >= 1 and letter not in opts:
            opts[letter] = text
    if len(opts) >= 4:
        return opts
    opts = {}
    for m in re.finditer(r"^\s*([A-G])\s*[\.．、]\s*(.+)$", block, re.M):
        letter = m.group(1)
        if letter not in opts:
            opts[letter] = clean(m.group(2))[:150]
    return opts if len(opts) >= 4 else None

def question_blocks(text, lo, hi):
    """Split text region into numbered question blocks within [lo,hi].

    Cloze sections have number collisions (blank markers vs option lists);
    prefer the occurrence whose block contains bracket options.
    """
    marks = [(m.start(), int(m.group(1))) for m in QNUM.finditer(text)]
    found = {}
    for i, (pos, num) in enumerate(marks):
        if not (lo <= num <= hi):
            continue
        end = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        mb = BOUNDARY.search(text, pos + 1, end)
        if mb:
            end = mb.start()
        body = text[pos:end]
        m = QNUM.match(body)
        content = body[m.end():].strip()
        has_opts = len(OPT.findall(content)) >= 4
        if num not in found or (has_opts and not found[num][1]):
            found[num] = (content, has_opts)
    return {n: c for n, (c, _) in found.items()}

WATERMARK = re.compile(r"【[^】]*】|微信公众号[^\s。]*|公众号[^\s。]*免费分享[^\s。]*|公众号：[^\s。]*|免费分享考研[^\s。]*|全年免费分享[^\s。]*|关注公众号[^\s。]*|共\s*\d+\s*页"
                       r"|英语\s*[（(][一二1I]{1,2}[）)]\s*试题\s*[.．]?\s*\d{0,2}\s*[.．]?"
                       r"|Section\s*(I{1,3}|IV)\b[^\n]{0,30}|[Uu]se\s*[Oo]f\s*[Ee]nglish")

def clean(s):
    s = WATERMARK.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s

def clean_passage(t, blanks=False):
    """Rebuild paragraphs from PDF line structure (indent >= 3 or blank line
    starts a new paragraph). blanks=True converts blank numbers to \u3016N\u3017."""
    if blanks:
        t = re.sub(r"(?m)^[ \t]*(\d{1,2})[\.．、]?[ \t]*$", "〖\\1〗", t)
        t = re.sub(r"[ \t]{2,}(\d{1,2})[\.．][ \t]*(?=[^\s\d])", " 〖\\1〗 ", t)
        t = re.sub(r"[ \t]{2,}(\d{1,2})[\.．][ \t]*\n", " 〖\\1〗\n", t)
        # bare inline number without period, spaces on both sides (e.g. 2020 style)
        t = re.sub(r"[ \t]{2,}(\d{1,2})[ \t]{2,}(?=[^\s\d])", " 〖\\1〗 ", t)
        t = re.sub(r"[ \t]{2,}(\d{1,2})[ \t]{2,}\n", " 〖\\1〗\n", t)
        # line-start variants (blank number begins the line)
        t = re.sub(r"(?m)^(\d{1,2})[\.．][ \t]+(?=[^\s\d])", "〖\\1〗 ", t)
        t = re.sub(r"(?m)^(\d{1,2})[ \t]{2,}(?=[^\s\d])", "〖\\1〗 ", t)
    paras, cur = [], []
    for ln in t.split("\n"):
        s = ln.strip()
        if not s:
            if cur:
                paras.append(cur)
                cur = []
            continue
        s = WATERMARK.sub(" ", s).strip()
        if not s:
            continue
        mt = re.match(r"^(Text|Passage)\s*(\d+)\s*[:.、]?\s*", s)
        if mt:
            s = s[mt.end():].strip()
            if not s:
                continue
        if len(ln) - len(ln.lstrip()) >= 3 and cur:
            paras.append(cur)
            cur = []
        cur.append(s)
    if cur:
        paras.append(cur)
    # drop remnant paragraphs: punctuation-only / "(10 points)" tails / directions heads
    def _keep(p):
        t = " ".join(p)
        # 段首 Directions 引导词剥离（避免误杀无空行分隔的作文题干）
        t = re.sub(r"^\s*(\d{1,2}\s*[\.．]?\s*)?Directions\s*[:：]?\s*", "", t).strip()
        if not t:
            return False
        # 仅丢弃纯题型指引样板段（短且含标志性短语）
        if len(t) < 320 and re.search(
                r"translate the underlined segments|Choose the best word|"
                r"some sentences have been removed|choose the most suitable subheading|"
                r"Mark your answers on", t, re.I):
            return False
        return not re.fullmatch(r"[\s\u3000.、。,，;；:：'\"()()\\-]*(\(\d+\s*points?\))?[\s\u3000.、。,，;；:：'\"()()\\-]*", t)
    paras = [p for p in paras if _keep(p)]
    return "\n\n".join(" ".join(p) for p in paras).strip()

def parse_year(year, text):
    t = norm(text)
    secs = split_sections(t)
    items, quality = [], {"sections": len(secs), "questions": 0, "raw_sections": []}

    def add(kind, **kw):
        rec = {"year": year, "type": kind}
        rec.update(kw)
        items.append(rec)

    # ---- cloze: passage + 20 questions
    cloze = secs.get("use_of_english", "")
    ok_q = 0
    if cloze:
        passage_m = re.search(r"\(10\s*points\)|ANSWER\s*SHEET", cloze, re.I)
        start = passage_m.end() if passage_m else 0
        mopt = re.search(r"(?m)^\s*1\s*[\.．]\s*(\[A\]|A[\.．\]])", cloze)
        passage = cloze[start:mopt.start()] if mopt else cloze[start:]
        add("passage", section="use_of_english", passage_id=None,
            text=clean_passage(passage, blanks=True))
        cloze_opts = parse_column_options(cloze[mopt.start():] if mopt else "")
        if not cloze_opts and mopt:
            # section header may split column layout (e.g. 2023 prints the
            # reading header between option rows and the D column)
            window = cloze[mopt.start():] + secs.get("reading", "")[:3000]
            cloze_opts = parse_abc_d_options(window)
        qblocks = question_blocks(cloze, 1, 20)
        for num in sorted(qblocks):
            opts = cloze_opts.get(num) or extract_options(qblocks[num])
            if cloze_opts.get(num):
                body = f"(blank {num})"
            else:
                body = OPT.sub("", qblocks[num]).strip()
                if len(body) < 3 or body == clean(" ".join(
                        (opts or {}).values())):
                    body = f"(blank {num})"
            add("question", section="use_of_english", number=num,
                text=clean(body), options=opts)
            if opts:
                ok_q += 1
    if ok_q < 10 and cloze:
        add("raw", section="use_of_english", text=clean(cloze[:3000]))
        quality["raw_sections"].append("use_of_english")

    # ---- reading
    reading = secs.get("reading", "")
    tmap = {"One": 1, "Two": 2, "Three": 3, "Four": 4, "1": 1, "2": 2, "3": 3, "4": 4}
    tmarks = [(m.start(), tmap.get(m.group(1))) for m in
              re.finditer(r"(?m)^\s*Text\s*(One|Two|Three|Four|[1-4])\b", reading)
              if m.group(1) in tmap]
    for i, (pos, pid) in enumerate(tmarks):
        end = tmarks[i + 1][0] if i + 1 < len(tmarks) else len(reading)
        seg = reading[pos:end]
        qlo, qhi = 21 + (pid - 1) * 5, 25 + (pid - 1) * 5
        m1 = re.search(r"(?m)^\s*2?\d{1,2}\s*[\.．]", seg)
        passage = seg[:m1.start()] if m1 else seg
        add("passage", section="reading", passage_id=pid,
            text=clean_passage(passage))
    qblocks = question_blocks(reading, 21, 40)
    for num in sorted(qblocks):
        opts = extract_options(qblocks[num])
        add("question", section="reading", number=num,
            text=clean(cut_body(qblocks[num])), options=opts)

    # ---- part B 41-45, translation 46-50
    mb = re.search(r"(?i)part\s*B", reading or "")
    mc = re.search(r"(?i)part\s*C", reading or "")
    partb_seg = reading[mb.end():mc.start()] if (mb and mc) else (reading[mb.end():] if mb else "")
    partc_seg = reading[mc.end():] if mc else ""
    qblocks = question_blocks(partb_seg, 41, 45)
    for num in sorted(qblocks):
        add("question", section="part_b", number=num,
            text=clean(cut_body(qblocks[num])), options=extract_options(qblocks[num]))
    if not qblocks and partb_seg:
        # gap-number questions may be glyph-damaged; recover the passage text
        bbody = partb_seg
        pts = re.search(r"\(10\s*points?\)", bbody, re.I)
        if pts:
            bbody = bbody[pts.end():]
        bbody = re.sub(r"(?m)^\s*[\[（(]([A-G])[\]）)].*$", "", bbody)  # [A]-[G] option lines
        bbody = re.sub(r"(?m)^\s*([A-G])\s*[\.．].*$", "", bbody)
        # 字形损坏的挖空号（巳/尸/口等孤立字符行）→ 顺序 〖41〗-〖45〗
        gc = [40]
        def _gap(m):
            gc[0] += 1
            return "\n〖%d〗\n" % gc[0]
        bbody = re.sub(r"(?m)^\s*[^A-Za-z0-9\s]{1,2}\s*$", _gap, bbody)
        # 此 PDF 区域每行都带缩进，indent 分段规则失效：
        # 去行首空白，仅以空行分段；〖N〗 独立成段（对应真实试卷的答题框）
        paras, cur = [], []
        for ln in bbody.split("\n"):
            ls = WATERMARK.sub(" ", ln).strip()
            if not ls:
                if cur:
                    paras.append(" ".join(cur))
                    cur = []
                continue
            if re.fullmatch(r"〖\d{1,2}〗", ls):
                if cur:
                    paras.append(" ".join(cur))
                    cur = []
                paras.append(ls)
                continue
            cur.append(ls)
        if cur:
            paras.append(" ".join(cur))
        ptext = "\n\n".join(x for x in paras if x).strip()
        if len(ptext) > 200:
            add("passage", section="part_b", passage_id=None, text=ptext)
    if not qblocks:
        pool = extract_options(partb_seg[:2500])
        if pool:
            add("question", section="part_b", number=None,
                text="(A-G options pool)", options=pool)
    # ---- translation 46-50 (inline "(46)" markers in passage)
    if partc_seg:
        body = partc_seg
        pts = re.search(r"\(10\s*points?\)", body, re.I)
        if pts:
            body = body[pts.end():]
        tmarks = list(re.finditer(r"\((4[6-9]|50)\)", body))
        # 原题划线止于句末：截到第一个（距句起点≥30字符）后接空白/结尾的句末标点
        spans = []
        for i, m in enumerate(tmarks):
            end = tmarks[i + 1].start() if i + 1 < len(tmarks) else len(body)
            seg = body[m.end():end]
            cut = None
            for pm in re.finditer(r'[.!?]["\'”’)]?(?=\s|$)', seg):
                if pm.end() >= 30:
                    cut = pm.end()
                    break
            if cut:
                seg = seg[:cut]
            spans.append((int(m.group(1)), m, seg))
        for num, m, seg in spans:
            add("question", section="translation", number=num,
                text=clean(seg)[:500], options=None)
        # 完整翻译原文：画线句用 〖N〗...〖/N〗 配对包裹（前端渲染下划线）
        parts, last = [], 0
        for num, m, seg in spans:
            parts.append(body[last:m.start()])
            parts.append("〖%d〗%s〖/%d〗" % (num, seg, num))
            last = m.end() + len(seg)
        parts.append(body[last:])
        ptext = clean_passage("".join(parts))
        if len(ptext) > 200:
            add("passage", section="translation", passage_id=None, text=ptext)

    # ---- writing: Part A 小作文 / Part B 大作文 分开成题
    writing = secs.get("writing", "")
    if writing:
        wparts = re.split(r"(?mi)^\s*(Part\s*[AB])\s*$", writing)
        for j in range(1, len(wparts) - 1, 2):
            label = wparts[j].replace(" ", "").replace("Part", "").upper()
            wtext = wparts[j + 1]
            mend = None
            for mm in re.finditer(r"\((10|20)\s*points?\)", wtext, re.I):
                mend = mm
            if mend:
                wtext = wtext[:mend.end()]  # 截掉图片残渣
            wptext = clean_passage(wtext)
            wptext = re.sub(r"^\s*(\d{1,2}\s*[\.．]?\s*)?Directions\s*[:：]?\s*", "", wptext).strip()
            if wptext:
                add("writing", section="writing", part=label, text=wptext[:1500])

    quality["questions"] = sum(1 for x in items if x["type"] == "question")
    return items, quality

def main():
    all_items, index = [], {}
    for f in sorted(glob.glob(os.path.join(RAW, "*.txt"))):
        year = int(re.search(r"(\d{4})", os.path.basename(f)).group(1))
        text = open(f, encoding="utf-8").read()
        items, quality = parse_year(year, text)
        all_items.extend(items)
        index[year] = quality
        print(f"[{year}] questions={quality['questions']} raw={quality['raw_sections']}")
    with open(os.path.join(OUT, "corpus.jsonl"), "w", encoding="utf-8") as fh:
        for it in all_items:
            fh.write(json.dumps(it, ensure_ascii=False) + "\n")
    with open(os.path.join(OUT, "corpus_index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2)
    total_q = sum(v["questions"] for v in index.values())
    print(f"TOTAL items={len(all_items)} questions={total_q} years={len(index)}")

if __name__ == "__main__":
    main()
