# -*- coding: utf-8 -*-
r"""Workbench KB import adapter (v1.1.1) — parse ONE file, print JSON to stdout.

Contract (called by server.js):
    python import_cli.py <format> <file>
    stdout: {"ok": true, "parser": "...", "records": [ {...}, ... ]}
            {"ok": false, "reason": "...", "hint": "..."}

Only stdlib is required for `tex`. `pdf` needs PyMuPDF (pip install pymupdf);
scanned PDFs (OCR) are NOT supported here — quarantine with a hint instead.

Parsers are vendored copies (see 导入解析-经验总结.md):
    tex_parser.py  <- english-corpus/scripts (TeX 源 ★★★ 最优)
    parse_corpus.py<- english-corpus/scripts (PDF 文本层拆题 ★★)
    exam_norm.py   <- importer/scripts       (统一契约归一化)
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import exam_norm  # noqa: E402


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def rid(*parts):
    import hashlib
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def parse_tex(path):
    import tex_parser
    raw = open(path, encoding="utf-8", errors="ignore").read()
    m = re.search(r"(\d{4})", os.path.basename(path))
    year = int(m.group(1)) if m else 0
    items = exam_norm.normalize(tex_parser.parse_year(year, raw))
    questions = [x for x in items if x["type"] == "question"]
    if not questions:
        out({"ok": False, "reason": "TeX 里没有解析出任何题目（检查 \\cloze/\\fourchoices/\\transnum 标记）"})
        return
    rec = {
        "id": rid(path, "tex"), "rtype": "qa_set",
        "title": f"{year} 年考研英语真题" if year else os.path.basename(path),
        "text": "", "items": items,
        "meta": {"year": year, "questions": len(questions),
                 "sections": sorted({x.get("section") for x in questions if x.get("section")})},
    }
    out({"ok": True, "parser": "tex-parser", "records": [rec]})


def parse_pdf(path):
    try:
        import fitz
    except ImportError:
        out({"ok": False, "reason": "服务器缺少 PyMuPDF，无法解析 PDF",
             "hint": "pip install pymupdf，或改用 TeX / TXT / MD / DOCX / HTML 源"})
        return
    doc = fitz.open(path)
    pages = [p.get_text("text", sort=True) for p in doc]
    n = len(doc)
    doc.close()
    full = "\n\n<<<PAGE>>>\n\n".join(pages)
    if len(full.strip()) < 3000:
        out({"ok": False, "reason": "PDF 文本层字数过少，疑似扫描件（OCR 不在工作台支持范围）",
             "hint": "请用导入工程的 OCR 管线处理，或改用 TeX / 文字版源"})
        return
    m = re.search(r"(\d{4})\s*年", os.path.basename(path)) or re.search(r"(20\d{2})\s*年", full[:2000])
    year = int(m.group(1)) if m else 0
    try:
        import parse_corpus
        items, quality = parse_corpus.parse_year(year, full)
        items = exam_norm.normalize(items)
    except Exception:
        items, quality = [], {"questions": 0}
    nq = quality.get("questions", 0)
    if nq >= 10:
        rec = {"id": rid(path, "exam"), "rtype": "qa_set",
               "title": f"{year} 年考研英语真题" if year else os.path.basename(path),
               "text": "", "items": items,
               "meta": {"year": year, "pages": n, **exam_norm.summarize(items)}}
        out({"ok": True, "parser": "pymupdf+parse_corpus", "records": [rec]})
    else:
        rec = {"id": rid(path, "doc"), "rtype": "document",
               "title": os.path.basename(path), "text": full,
               "meta": {"year": year, "pages": n, "chars": len(full),
                        "note": "拆题未达阈值，存为整篇文档"}}
        out({"ok": True, "parser": "pymupdf-textlayer", "records": [rec]})


def main():
    if len(sys.argv) < 3:
        out({"ok": False, "reason": "usage: import_cli.py <tex|pdf> <file>"})
        return 1
    fmt, path = sys.argv[1], sys.argv[2]
    try:
        if fmt == "tex":
            parse_tex(path)
        elif fmt == "pdf":
            parse_pdf(path)
        else:
            out({"ok": False, "reason": f"未知格式 {fmt}"})
            return 1
    except Exception as e:
        out({"ok": False, "reason": f"解析异常: {e}"})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
