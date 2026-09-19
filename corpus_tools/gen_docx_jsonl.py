# -*- coding: utf-8 -*-
"""Generate exams.jsonl from the docx source (v2.6.0 题源整体替换)."""
import json, os, re, sys, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.stdout.reconfigure(encoding="utf-8")

import docx_parser as DP
import exam_norm as EN

ROOT = r'C:\Users\兰某\Desktop\zhenti'
OUT = r'D:\ai\opencode\momo\english-workbench\corpus\exams_docx.jsonl'


def year_of(fn):
    m = re.search(r'(\d{4})', fn)
    return int(m.group(1)) if m else 0


def title_of(year, fn):
    if '旧' in fn:
        return f'{year} 年考研英语真题（旧）'
    return f'{year} 年考研英语真题'


def main():
    files = sorted(f for f in os.listdir(ROOT) if f.endswith('.docx'))
    recs = []
    report = []
    for fn in files:
        year = year_of(fn)
        if not year:
            continue
        paras = DP.docx_paras(os.path.join(ROOT, fn))
        items = DP.parse_year(year, paras)
        items = EN.normalize(items)
        rec = {
            'id': hashlib.sha1(fn.encode()).hexdigest()[:12],
            'rtype': 'qa_set',
            'title': title_of(year, fn),
            'text': '',
            'items': items,
            'meta': {'year': year, 'chars': sum(len(x.get('text') or '') for x in items),
                     **EN.summarize(items)},
            'source': {'file': fn, 'category': '真题', 'parser': 'docx2026',
                       'imported_at': '2026-09-19T19:11:02', 'managed': 'manual',
                       'origin': 'local_docx'},
        }
        recs.append(rec)
        secs = {}
        for x in items:
            k = (x['section'], x['type'])
            secs[k] = secs.get(k, 0) + 1
        report.append((year, len(items), EN.summarize(items)['questions'], secs))

    # 按年份排序
    recs.sort(key=lambda r: r['meta']['year'])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as w:
        for r in recs:
            w.write(json.dumps(r, ensure_ascii=False) + '\n')
    os.replace(tmp, OUT)
    print('written:', OUT, 'records:', len(recs))
    print(f"{'year':>5} {'items':>6} {'qs':>4}  sections")
    for (y, n, q, sec) in report:
        s = ' '.join(f"{a[:12]}:{b}/{c}" for (a, b), c in sorted(sec.items(), key=str))
        print(f"{y:>5} {n:>6} {q:>4}  {s}")


if __name__ == '__main__':
    main()
