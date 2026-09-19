# -*- coding: utf-8 -*-
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
P = r'D:\ai\opencode\momo\english-workbench\corpus\exams_docx.jsonl'
recs = [json.loads(l) for l in open(P, encoding='utf-8')]
for y in (2010, 1999):
    d = next(r for r in recs if r['meta']['year'] == y)
    items = d['items']
    print(f"\n===== {y} =====")
    for i, it in enumerate(items):
        sec = it.get('section')
        if sec in ('reading', 'part_b', 'translation'):
            t = (it.get('text') or '').replace('\n', ' ')
            print(f"[{i:>2}] {it['type']:<8} {sec:<10} pid={str(it.get('passage_id')):<4} n={str(it.get('number')):<4} len={len((it.get('text') or '')):<5} opts={str(list((it.get('options') or {}).keys()))[:40]:<42} | {t[:70]}")
