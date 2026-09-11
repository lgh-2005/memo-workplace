# -*- coding: utf-8 -*-
r"""Parse yearly TeX exam sources (EN201-kaoyan, 1994-2023) into corpus records.

Same schema as parse_corpus.py plus "src": "tex".
Key wins over PDF/OCR: \fourchoices = exact option grouping,
\transnum\uline{} = exact translation sentences, \cloze = ordered blanks.

v2.1.3 修复（真题库全量重导）：
  1. \newlinespread{X}{...} 包裹体：先剥离命令保留正文，避免 catch-all 吞掉整段翻译。
  2. 翻译句 (49)/(50) \uline{...} 变体（2020）纳入抽取。
  3. 裸 {..}{..}{..}{..} 选项（1994/1996/1999 个别漏写 \fourchoices）兜底识别。
  4. A./B./C./D. 文本选项（2008 等）按行识别；支持续行。
  5. 完形/阅读 Directions 段落过滤扩充（numbered blank / four choices / ANSWER SHEET…）。
  6. Part B：选项池统一为 {A..H} 字典；空位 41-45 归一为 〖N〗 并生成对应题目；
     兼容 linefill / tabular「41. &」/ (41) 段落标记 / 独立数字（2022/2023 排序题）。
  7. 翻译答案句数上限 5；多余（源缺陷，如 2023）连同所在段落一并剔除。
"""
import glob, json, os, re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXDIR = os.path.join(BASE, "texsrc")

SEC_PATS = [
    ("use_of_english", re.compile(r"use\s*of\s*english|close\s*test|cloze", re.I)),
    ("reading", re.compile(r"reading\s*comprehension", re.I)),
    ("translation", re.compile(r"translation", re.I)),
    ("writing", re.compile(r"writing", re.I)),
]

# 只丢弃「段落开头就是指令语」的说明段，避免句中出现 directions/answers 等词被误删
# （如 1994 "...in innumerable directions."、1998 同理）。
DIRECTION_RE = re.compile(
    r"^\s*(?:\d+[.、]\s*)?(?:Part\s+[A-C]\s*)?"
    r"(Directions|For each numbered blank|Read the following|In the following|"
    r"The following paragraphs|You are going to read|Choose the best|"
    r"Translate the underlined|translation should be written|"
    r"Mark your answers|Answer the questions)", re.I)


def tex_clean(s):
    s = s.replace("\\&", "&").replace("``", "\u201c").replace("''", "\u201d")
    s = s.replace("---", "\u2014").replace("--", "-").replace("\\%", "%")
    for _ in range(3):
        s = re.sub(r"\\(?:uline|textbf|emph|underline|textit)\s*{([^{}]*)}", r"\1", s)
    return s


def tokenize(raw):
    """Pull out structured tokens, leave plain text."""
    trans, choices = [], []
    # v2.1.3：剥离 \newlinespread{1.2}{ ... } 包裹命令，保留正文（否则其后的 {..} 会被
    # catch-all 当作命令参数吞掉，1995/1998/1999/2000/2009 翻译整段丢失）。
    raw = re.sub(r"\\newlinespread\s*\{[^{}]*\}", "", raw)
    def grab_trans(m):
        trans.append(re.sub(r"\s+", " ", tex_clean(m.group(1))).strip())
        return f"\n<<<TRANS{len(trans)-1}>>>\n"
    raw = re.sub(r"\\transnum\s*\\uline\s*\*", "", raw)
    raw = re.sub(r"\\transnum\s*(?:\\uline\s*)?{((?:[^{}]*{[^{}]*})*[^{}]*)}", grab_trans, raw)
    # v2.1.3：兼容 2020 "(49) \uline{...}" 无 \transnum 的写法
    raw = re.sub(r"\(\s*\d{1,3}\s*\)\s*\\uline\s*{((?:[^{}]*{[^{}]*})*[^{}]*)}", grab_trans, raw)
    def grab_ch(m):
        choices.append([tex_clean(g.strip()).strip("{} \t\n") for g in m.groups()])
        return f"\n<<<CH{len(choices)-1}>>>\n"
    raw = re.sub(r"\\fourchoices\s*({(?:[^{}]|{[^{}]*})*})\s*({(?:[^{}]|{[^{}]*})*})\s*({(?:[^{}]|{[^{}]*})*})\s*({(?:[^{}]|{[^{}]*})*})", grab_ch, raw)
    # v2.1.3：兜底识别裸 {..}x4（1994/1996/1999 个别小题漏写 \fourchoices）
    raw = re.sub(r"\{\s*([^{}\n]{4,}?)\s*\}\s*\n\s*\{\s*([^{}\n]{4,}?)\s*\}\s*\n\s*\{\s*([^{}\n]{4,}?)\s*\}\s*\n\s*\{\s*([^{}\n]{4,}?)\s*\}", grab_ch, raw)
    raw = re.sub(r"\\\\[ \t]*", "\n", raw)  # TeX \\ = line break
    raw = re.sub(r"\n[ \t]*\n+", "\n<<<P>>>\n", raw)
    raw = re.sub(r"\\linefill\s*\.?", "\n<<<GAP>>>\n", raw)
    raw = raw.replace("\\cloze", "\n<<<CLOZE>>>\n")
    raw = raw.replace("\\item", "\n<<<ITEM>>>\n")
    raw = raw.replace("\\begin{listmatch}", "\n<<<LIST>>>\n").replace("\\end{listmatch}", "\n<<<ENDLIST>>>\n")
    raw = re.sub(r"\\subsection\s*\*?\s*{([^}]*)}", r"\n<<<SUB \1>>>\n", raw)
    raw = re.sub(r"\\section\s*\*?\s*{([^}]*)}", r"\n<<<SEC \1>>>\n", raw)
    # comments + leftovers
    raw = "\n".join(re.sub(r"(?<!\\)%.*", "", ln) for ln in raw.split("\n"))
    raw = re.sub(r"\\(?:textbf|textit|emph)\s*\{\s*(Part\s+[A-C])\s*\}", r"\n\1\n", raw)
    # v1.1.7 修复：在 catch-all 去除所有命令之前，先展开保内容命令，避免 \emph{Nature} 等关键词被剥离
    for _ in range(4):
        raw = re.sub(r'\\(?:uline|textbf|emph|underline|textit)\s*\{([^{}]*)\}', r'\1', raw)
    raw = re.sub(r"\\[a-zA-Z]+\s*(\[[^\]]*\])?(\{[^{}]*\})*", "\n", raw)
    raw = re.sub(r"[{}]", "", raw)
    raw = re.sub(r"[ \t]+", " ", raw)
    return raw, trans, choices


def _norm_partb_gaps(text):
    """把 Part B 各种空位写法统一成 〖41〗..〖45〗。"""
    t = text.replace("\\[", "").replace("\\]", "")
    t = re.sub(r"\(\s*(4[1-5])\s*\)", lambda m: f"\u3016{m.group(1)}\u3017", t)  # (41) 段落标记（2022）
    t = re.sub(r"(4[1-5])\s*\.\s*&", lambda m: f"\u3016{m.group(1)}\u3017", t)  # tabular 41. &
    t = re.sub(r"(?m)^\s*(4[1-5])\s*$", lambda m: f"\u3016{m.group(1)}\u3017", t)  # 独立数字（2023）
    return t


def parse_year(year, raw):
    text, trans, choices = tokenize(raw)
    items = []
    st = {"sec": None, "sub": None, "item_no": 0, "cloze_n": 0, "gap_n": 0,
          "collect": "passage", "in_list": False, "part": None, "offset": 0,
          "trans_n": 0, "w_n": 0}
    passage = {"buf": []}
    pb_buf = {"buf": []}
    pool = {"opts": []}
    cur = {"text": [], "ch": None, "ch_txt": {}, "last_opt": None}

    def reset_cur():
        cur["text"] = []
        cur["ch"] = None
        cur["ch_txt"] = {}
        cur["last_opt"] = None

    def add_item():
        body = re.sub(r"\s+", " ", " ".join(
            x for x in cur["text"] if x != "<<<P>>>")).strip()
        sec = st["sec"]
        ch = cur["ch"]
        if ch is None and len(cur["ch_txt"]) == 4:
            ch = [cur["ch_txt"][L] for L in "ABCD"]
        if sec in ("use_of_english", "reading") and ch is not None:
            for v in ch:  # 源缺陷：题干开头重复了某个选项词（如 1999 P3）
                v = (v or "").strip()
                if v and len(body) > len(v) and body.lower().startswith(v.lower()):
                    body = body[len(v):]
                    break
            body = re.sub(r"^[.。;；:：\s]+", "", body).strip()
            n = st["item_no"] + st["offset"]
            opts = {L: v for L, v in zip("ABCD", ch)}
            if not body:
                body = f"(blank {n})" if sec == "use_of_english" else ""
            items.append({"year": year, "type": "question", "src": "tex",
                          "section": sec, "number": n, "text": body,
                          "options": opts,
                          "passage_id": st["sub"] if sec == "reading" and not st["part"] else None})
        reset_cur()

    def flush_passage():
        joined = " ".join(passage["buf"])
        paras = []
        for para in joined.split("<<<P>>>"):
            para = re.sub(r"\s+", " ", para).strip()
            if not para or DIRECTION_RE.search(para):
                continue
            paras.append(para)
        buf = "\n\n".join(paras).strip()
        passage["buf"] = []
        if not buf:
            return
        sec = st["sec"]
        if sec == "use_of_english":
            items.append({"year": year, "type": "passage", "src": "tex",
                          "section": "use_of_english", "text": buf})
        elif sec == "reading" and st["sub"] and not st["part"]:
            items.append({"year": year, "type": "passage", "src": "tex",
                          "section": "reading", "passage_id": st["sub"], "text": buf})
        elif sec == "reading" and st["part"] == "C":
            items.append({"year": year, "type": "passage", "src": "tex",
                          "section": "translation", "text": buf})
        elif sec == "translation":
            items.append({"year": year, "type": "passage", "src": "tex",
                          "section": "translation", "text": buf})
        elif sec == "writing":
            st["w_n"] += 1
            items.append({"year": year, "type": "writing", "src": "tex",
                          "section": "writing",
                          "part": "A" if st["w_n"] == 1 else "B", "text": buf})

    def flush_partb():
        joined = " ".join(pb_buf["buf"])
        paras = []
        for para in joined.split("<<<P>>>"):
            para = re.sub(r"\s+", " ", para).strip()
            if not para or DIRECTION_RE.search(para):
                continue
            paras.append(para)
        pb_buf["buf"] = []
        buf = "\n\n".join(paras).strip()
        if buf:
            items.append({"year": year, "type": "passage", "src": "tex",
                          "section": "part_b", "text": buf})
        if pool["opts"]:
            letters = [chr(65 + i) for i in range(len(pool["opts"]))]
            opts = {L: v for L, v in zip(letters, pool["opts"])}
            items.append({"year": year, "type": "question", "src": "tex",
                          "section": "part_b", "number": None,
                          "text": f"({letters[0]}-{letters[-1]} options pool)",
                          "options": opts})
            pool["opts"] = []

    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        if line == "<<<GAP>>>":
            st["gap_n"] += 1
            if st["part"] == "B":
                pb_buf["buf"].append(f"\u3016{40 + st['gap_n']}\u3017")
            continue
        if line == "<<<P>>>":
            if st["collect"] in ("item", "pool"):
                continue
            (pb_buf if st["part"] == "B" else passage)["buf"].append(line)
            continue
        if line.startswith("<<<SEC"):
            add_item(); flush_passage(); flush_partb()
            title = line[6:-3].strip()
            prev_sec, prev_count = st["sec"], st["item_no"]
            st["sec"] = next((n for n, p in SEC_PATS if p.search(title)), None)
            st["sub"] = None; st["part"] = None; st["collect"] = "passage"
            st["item_no"] = 0; st["cloze_n"] = 0; st["gap_n"] = 0; st["trans_n"] = 0; st["w_n"] = 0
            if st["sec"] == "reading" and prev_sec == "use_of_english":
                st["offset"] = prev_count
            elif st["sec"] == "translation":
                st["offset"] = prev_count + (5 if year >= 2002 else 0)
            else:
                st["offset"] = 0
            continue
        if line.startswith("<<<SUB"):
            add_item(); flush_passage()
            m = re.search(r"(Text|Passage)\s*(\d+)", line, re.I)
            st["sub"] = int(m.group(2)) if m else None
            st["collect"] = "passage"
            continue
        if re.match(r"^Part\s+[ABC]$", line):
            add_item(); flush_passage(); flush_partb()
            if st["sec"] == "reading":
                letter = line.split()[-1]
                # v2.1.3：2005 前无「新题型」，阅读 Part B 实为英译汉，归入翻译
                st["part"] = None if letter == "A" else ("C" if (letter == "B" and year < 2005) else letter)
                st["sub"] = None
            st["collect"] = "passage"
            continue
        if line.startswith("<<<LIST>>>"):
            add_item(); st["in_list"] = True
            continue
        if line.startswith("<<<ENDLIST>>>"):
            add_item(); st["in_list"] = False
            st["collect"] = "passage"  # v2.1.3：否则后续正文被并入最后一个池选项
            continue
        if line.startswith("<<<CLOZE>>>"):
            st["cloze_n"] += 1
            (pb_buf if st["part"] == "B" else passage)["buf"].append(
                f"\u3016{st['cloze_n']}\u3017" if st["sec"] == "use_of_english" else "")
            continue
        if line.startswith("<<<ITEM>>>"):
            add_item()
            if st["sec"] == "writing":
                # 写作提示中的列举项（\item）属于题干，不能当题目处理
                passage["buf"].append("<<<P>>>")
                st["collect"] = "passage"
                continue
            if st["in_list"]:
                pool["opts"].append("")
                st["collect"] = "pool"
            else:
                st["item_no"] += 1
                st["collect"] = "item"
            continue
        mch = re.match(r"^<<<CH(\d+)>>>$", line)
        if mch:
            cur["ch"] = choices[int(mch.group(1))]
            continue
        mtr = re.match(r"^<<<TRANS(\d+)>>>$", line)
        if mtr:
            add_item()
            st["item_no"] += 1
            st["trans_n"] += 1
            base_tr = 45 if year >= 2005 else (60 if year >= 2002 else 70)
            n_tr = base_tr + st["trans_n"]
            items.append({"year": year, "type": "question", "src": "tex",
                          "section": "translation", "number": n_tr,
                          "text": trans[int(mtr.group(1))], "options": None})
            sent = trans[int(mtr.group(1))]
            (pb_buf if st["part"] == "B" else passage)["buf"].append(
                f"\u3016{n_tr}\u3017{sent}\u3016/{n_tr}\u3017")
            st["collect"] = "passage"
            continue
        if st["sec"] is None:
            continue
        if st["collect"] == "item":
            mo = re.match(r"^([A-D])[.、]\s*(.*)$", line)
            if mo:
                cur["ch_txt"][mo.group(1)] = mo.group(2).strip()
                cur["last_opt"] = mo.group(1)
            elif cur["ch_txt"] and cur["last_opt"]:
                cur["ch_txt"][cur["last_opt"]] = (
                    cur["ch_txt"][cur["last_opt"]] + " " + line).strip()
            else:
                cur["text"].append(line)
        elif st["collect"] == "pool":
            if pool["opts"]:
                pool["opts"][-1] = (pool["opts"][-1] + " " + line).strip()
        elif st["part"] == "B":
            pb_buf["buf"].append(line)
        else:
            passage["buf"].append(line)
    add_item(); flush_passage(); flush_partb()

    # Part B：归一空位标记并补齐 41-45 题
    for it in [x for x in items if x.get("section") == "part_b" and x["type"] == "passage"]:
        it["text"] = _norm_partb_gaps(it["text"])
        nums = sorted({int(m) for m in re.findall(r"\u3016(4[1-5])\u3017", it["text"])})
        for n in nums:
            if not any(q.get("section") == "part_b" and q["type"] == "question"
                       and q.get("number") == n for q in items):
                items.append({"year": year, "type": "question", "src": "tex",
                              "section": "part_b", "number": n,
                              "text": f"(Part B 第 {n} 空)", "options": None})

    # 翻译答案句上限 5；多余（源缺陷，如 2023）连同所在段落剔除
    tq = sorted((x for x in items if x["type"] == "question" and x.get("section") == "translation"),
                key=lambda x: x["number"])
    if len(tq) > 5:
        drop = tq[5:]
        drop_nums = {q["number"] for q in drop}
        items[:] = [x for x in items if x not in drop]
        for it in items:
            if it["type"] == "passage" and it.get("section") == "translation":
                paras = [p for p in it["text"].split("\n\n")
                         if not any(f"\u3016{n}\u3017" in p for n in drop_nums)]
                it["text"] = "\n\n".join(paras).strip()
    return items


def main():
    all_items, index = [], {}
    for f in sorted(glob.glob(os.path.join(TEXDIR, "*.tex"))):
        year = int(re.search(r"(\d{4})", os.path.basename(f)).group(1))
        raw = open(f, encoding="utf-8", errors="ignore").read()
        items = parse_year(year, raw)
        from collections import Counter
        c = Counter(x.get("section") for x in items if x["type"] == "question")
        nopts = sum(1 for x in items if x["type"] == "question" and x.get("options"))
        index[year] = {"questions": sum(c.values()), "with_options": nopts,
                       "by_section": {k: v for k, v in c.items() if k}}
        print(f"[{year}] q={sum(c.values())} opt={nopts} {dict(c)}")
        all_items.extend(items)
    with open(os.path.join(BASE, "data", "corpus_tex.jsonl"), "w", encoding="utf-8") as f:
        for it in all_items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    with open(os.path.join(BASE, "data", "corpus_tex_index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print("TOTAL", len(all_items))


if __name__ == "__main__":
    main()
