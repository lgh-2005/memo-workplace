# -*- coding: utf-8 -*-
r"""Parse yearly TeX exam sources (EN201-kaoyan, 1994-2023) into corpus records.

Same schema as parse_corpus.py plus "src": "tex".
Key wins over PDF/OCR: \fourchoices = exact option grouping,
\transnum\uline{} = exact translation sentences, \cloze = ordered blanks.
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

def tex_clean(s):
    s = s.replace("\\&", "&").replace("``", "\u201c").replace("''", "\u201d")
    s = s.replace("---", "\u2014").replace("--", "-").replace("\\%", "%")
    for _ in range(3):
        s = re.sub(r"\\(?:uline|textbf|emph|underline|textit)\s*{([^{}]*)}", r"\1", s)
    return s

def tokenize(raw):
    """Pull out structured tokens, leave plain text."""
    trans, choices = [], []
    def grab_trans(m):
        trans.append(re.sub(r"\s+", " ", tex_clean(m.group(1))).strip())
        return f"\n<<<TRANS{len(trans)-1}>>>\n"
    raw = re.sub(r"\\transnum\s*\\uline\s*\*", "", raw)
    raw = re.sub(r"\\transnum\s*(?:\\uline\s*)?{((?:[^{}]*{[^{}]*})*[^{}]*)}", grab_trans, raw)
    def grab_ch(m):
        choices.append([tex_clean(g.strip()).strip("{} \t\n") for g in m.groups()])
        return f"\n<<<CH{len(choices)-1}>>>\n"
    raw = re.sub(r"\\fourchoices\s*({(?:[^{}]|{[^{}]*})*})\s*({(?:[^{}]|{[^{}]*})*})\s*({(?:[^{}]|{[^{}]*})*})\s*({(?:[^{}]|{[^{}]*})*})", grab_ch, raw)
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
    raw = re.sub(r"\\[a-zA-Z]+\s*(\[[^\]]*\])?(\{[^{}]*\})*", "\n", raw)
    raw = re.sub(r"[{}]", "", raw)
    raw = re.sub(r"[ \t]+", " ", raw)
    return raw, trans, choices

def parse_year(year, raw):
    text, trans, choices = tokenize(raw)
    items = []
    st = {"sec": None, "sub": None, "item_no": 0, "cloze_n": 0, "gap_n": 0,
          "collect": "passage", "in_list": False, "part": None, "offset": 0,
          "trans_n": 0, "w_n": 0}
    passage = {"buf": []}
    pb_buf = {"buf": []}
    pool = {"opts": []}
    cur = {"text": [], "ch": None}

    def add_item():
        body = re.sub(r"\s+", " ", " ".join(
            x for x in cur["text"] if x != "<<<P>>>")).strip()
        sec = st["sec"]
        if sec in ("use_of_english", "reading") and cur["ch"] is not None:
            n = st["item_no"] + st["offset"]
            opts = {L: v for L, v in zip("ABCD", cur["ch"])}
            if not body:
                body = f"(blank {n})" if sec == "use_of_english" else ""
            items.append({"year": year, "type": "question", "src": "tex",
                          "section": sec, "number": n, "text": body,
                          "options": opts,
                          "passage_id": st["sub"] if sec == "reading" and not st["part"] else None})
        cur["text"] = []
        cur["ch"] = None

    def flush_passage():
        joined = " ".join(passage["buf"])
        paras = []
        for para in joined.split("<<<P>>>"):
            para = re.sub(r"\s+", " ", para).strip()
            if not para or re.search(r"Directions|Choose the best word|translate the underlined|In the following text|Mark your answers", para):
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
                          "section": "translation", "text": buf[:2500]})
        elif sec == "translation":
            items.append({"year": year, "type": "passage", "src": "tex",
                          "section": "translation", "text": buf[:2500]})
        elif sec == "writing":
            st["w_n"] += 1
            items.append({"year": year, "type": "writing", "src": "tex",
                          "section": "writing",
                          "part": "A" if st["w_n"] == 1 else "B", "text": buf[:1500]})

    def flush_partb():
        joined = " ".join(pb_buf["buf"])
        paras = []
        for para in joined.split("<<<P>>>"):
            para = re.sub(r"\s+", " ", para).strip()
            if not para or re.search(r"Directions|translate the underlined|Write an essay|In the following text|Mark your answers", para):
                continue
            paras.append(para)
        pb_buf["buf"] = []
        buf = "\n\n".join(paras).strip()
        if buf:
            items.append({"year": year, "type": "passage", "src": "tex",
                          "section": "part_b", "text": buf})
        if pool["opts"]:
            items.append({"year": year, "type": "question", "src": "tex",
                          "section": "part_b", "number": None,
                          "text": "(A-G options pool)", "options": pool["opts"]})
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
                st["part"] = None if line.split()[-1] == "A" else line.split()[-1]
                st["sub"] = None
            st["collect"] = "passage"
            continue
        if line.startswith("<<<LIST>>>"):
            add_item(); st["in_list"] = True
            continue
        if line.startswith("<<<ENDLIST>>>"):
            add_item(); st["in_list"] = False
            continue
        if line.startswith("<<<CLOZE>>>"):
            st["cloze_n"] += 1
            (pb_buf if st["part"] == "B" else passage)["buf"].append(
                f"\u3016{st['cloze_n']}\u3017" if st["sec"] == "use_of_english" else "")
            continue
        if line.startswith("<<<ITEM>>>"):
            add_item()
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
            cur["text"].append(line)
        elif st["collect"] == "pool":
            if pool["opts"]:
                pool["opts"][-1] = (pool["opts"][-1] + " " + line).strip()
        elif st["part"] == "B":
            pb_buf["buf"].append(line)
        else:
            passage["buf"].append(line)
    add_item(); flush_passage(); flush_partb()

    # part B inline gap questions 41-45 (standalone numbers in passage)
    for it in [x for x in items if x.get("section") == "part_b" and x["type"] == "passage"]:
        gaps = re.findall(r"(?m)^\s*(4[1-5])\s*[\.．]?\s*$", it["text"])
        for g in gaps:
            items.append({"year": year, "type": "question", "src": "tex",
                          "section": "part_b", "number": int(g),
                          "text": f"(gap {g} in Part B passage)", "options": None})
        it["text"] = re.sub(r"(?m)^\s*(4[1-5])\s*[\.．]?\s*$", f"(gap \\1)", it["text"])
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
