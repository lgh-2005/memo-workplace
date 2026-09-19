# -*- coding: utf-8 -*-
"""从桌面整卷 docx 重建真题库 exams.jsonl（v2.6.1 重建版）。"""
import json, os, re, sys, hashlib, io
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.stdout.reconfigure(encoding='utf-8')

import exam_docx as EX

SRC = r'C:\Users\兰某\Desktop\zhenti'
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'corpus', 'exams.jsonl')


def main():
    files = sorted(f for f in os.listdir(SRC) if f.endswith('.docx'))
    recs, report = [], []
    for fn in files:
        m = re.search(r'(\d{4})', fn)
        if not m:
            continue
        year = int(m.group(1))
        runs = EX.docx_runs(os.path.join(SRC, fn))
        paras = [r for r in runs if ''.join(t for t, _ in r).strip()]
        items = EX.parse_year(year, paras)
        items = EX.normalize(items)
        rec = {
            'id': hashlib.sha1(fn.encode('utf-8')).hexdigest()[:12],
            'rtype': 'qa_set',
            'title': f'{year} 年考研英语真题' + ('（旧）' if '旧' in fn else ''),
            'text': '',
            'items': items,
            'meta': {'year': year, 'chars': sum(len(x.get('text') or '') for x in items),
                     **EX.summarize(items)},
            'source': {'file': fn, 'category': '真题', 'parser': 'docx-v2',
                       'imported_at': '2026-09-19T20:00:00', 'managed': 'manual',
                       'origin': 'local_docx'},
        }
        recs.append(rec)
        report.append((year, items))
    recs.sort(key=lambda r: r['meta']['year'])
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as w:
        for r in recs:
            w.write(json.dumps(r, ensure_ascii=False) + '\n')
    os.replace(tmp, OUT)
    print('written:', OUT, 'records:', len(recs))
    for year, items in report:
        secs = {}
        for it in items:
            k = (it['section'], it['type'])
            secs[k] = secs.get(k, 0) + 1
        qs = [x for x in items if x['type'] == 'question']
        anchors = set()
        for it in items:
            if it['type'] == 'passage':
                anchors = sorted(set(anchors) | {int(x) for x in re.findall(r'〖(\d+)〗', it['text'])})
        s = ' '.join(f'{a[:12]}:{b}/{c}' for (a, b), c in sorted(secs.items(), key=str))
        print(f"{year:>5} q={len(qs):>3} score={sum(x.get('score') or 0 for x in qs):>6.1f} anchors={anchors[:3]}..{anchors[-1:] if anchors else ''} {s}")


if __name__ == '__main__':
    main()
