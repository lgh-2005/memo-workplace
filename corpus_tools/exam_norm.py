# -*- coding: utf-8 -*-
r"""Exam question-type recognition and structure normalization.

Adds to every question record:
  qtype   单选 / 多选 / 判断 / 匹配 / 填空 / 解答 / 作文
  score   per-question score when derivable (section points / question count)
  answer  answering mode: 涂卡 / 书写 / 作文纸
Score is inferred from standard section point values, overridable by
explicit "(N points)" found in writing prompts.
"""
import re

SECTION_RULES = {
    # section: (default qtype, section total points, per-q fallback)
    "use_of_english": ("单选", 10),
    "reading": ("单选", 40),
    "part_b": ("匹配", 10),
    "translation": ("解答", 10),
    "writing": ("作文", None),
}

ANSWER_MODE = {"单选": "涂卡", "判断": "涂卡", "匹配": "涂卡",
               "填空": "书写", "解答": "书写", "多选": "涂卡", "作文": "作文纸"}


def detect_qtype(item):
    """Section-first, then content evidence."""
    sec = item.get("section")
    opts = item.get("options") or {}
    text = item.get("text") or ""
    if sec == "writing":
        return "作文"
    if sec == "part_b":
        return "匹配"
    if opts:
        n = len(opts)
        if n == 4:
            return "单选"
        if n == 2:
            return "判断"
        if n > 4:
            return "多选"
        return "单选"  # partial options, safest default for exams
    if sec == "part_b":
        return "匹配"
    if re.search(r"_{3,}|【填空】|（\s*\d+\s*）\s*[。：:]?\s*$", text):
        return "填空"
    if len(text) > 120 and "?" not in text and "？" not in text:
        return "解答"
    return "解答"


def score_items(items):
    """Distribute standard section points over questions; writing uses its own."""
    from collections import Counter
    counts = Counter(x.get("section") for x in items
                     if x["type"] == "question" and x.get("number") is not None)
    for it in items:
        if it["type"] not in ("question", "writing"):
            continue
        sec = it.get("section")
        qtype = it.get("qtype")
        if qtype == "作文":
            m = re.search(r"[（(]\s*(\d{1,2})\s*(?:points|分)\s*[）)]", it.get("text") or "")
            it["score"] = int(m.group(1)) if m else None
            continue
        total = SECTION_RULES.get(sec, (None, None))[1]
        n = counts.get(sec, 0)
        if total and n:
            it["score"] = round(total / n, 2)
        else:
            it["score"] = None


def _link_reading(items):
    """Reading Part A: attach questions to their Text passage (fills missing
    passage_id; English One standard = 4 texts x 5 questions from No.21)."""
    pids = sorted({x.get("passage_id") for x in items
                   if x["type"] == "passage" and x.get("section") == "reading"
                   and x.get("passage_id") is not None})
    if not pids:
        return
    qs = sorted((x for x in items
                 if x["type"] == "question" and x.get("section") == "reading"
                 and x.get("passage_id") is None and x.get("number") is not None),
                key=lambda x: x["number"])
    if not qs:
        return
    np_ = len(pids)
    if len(qs) == np_ * 5 and qs[0]["number"] == 21:
        for i, q in enumerate(qs):
            q["passage_id"] = pids[i // 5]
    else:
        per = max(1, round(len(qs) / np_))
        for i, q in enumerate(qs):
            q["passage_id"] = pids[min(i // per, np_ - 1)]


def _order_items(items):
    """板块固定排序：题干（原文/作文题）在前，题目在后；板块间保持首次出现顺序。"""
    groups, order = {}, []
    for it in items:
        sec = it.get("section")
        if sec not in groups:
            groups[sec] = ([], [])
            order.append(sec)
        groups[sec][0 if it["type"] in ("passage", "writing", "raw") else 1].append(it)
    out = []
    for sec in order:
        out.extend(groups[sec][0])
        out.extend(groups[sec][1])
    return out


def normalize(items):
    for it in items:
        if it["type"] not in ("question", "writing"):
            continue
        it["qtype"] = detect_qtype(it)
        it["answer"] = ANSWER_MODE.get(it["qtype"], "书写")
    _link_reading(items)
    score_items(items)
    return _order_items(items)


def summarize(items):
    from collections import Counter
    qs = [x for x in items if x["type"] == "question"]
    return {
        "questions": len(qs),
        "by_qtype": dict(Counter(x["qtype"] for x in qs)),
        "total_score": sum(x.get("score") or 0 for x in qs) or None,
    }
