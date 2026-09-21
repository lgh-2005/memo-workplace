# -*- coding: utf-8 -*-
"""
v2.6.3 单元题库标准答案回填：从 corpus/exams.jsonl 生成 data/answers.json。
数据口径与 server.js buildUnits() 的 gkey 完全一致：
  reading -> reading~<passage_id>；writing -> writing~<part>；其余 -> <section>~0
只收录客观题（有字母答案的 question）；翻译/写作单元不产生条目。
"""
import json, os, sys

ROOT = r'D:\ai\opencode\momo\english-workbench'
sys.stdout.reconfigure(encoding='utf-8')
EXAMS = os.path.join(ROOT, 'corpus', 'exams.jsonl')
OUT = os.path.join(ROOT, 'data', 'answers.json')

recs = [json.loads(l) for l in open(EXAMS, encoding='utf-8') if l.strip()]

def gkey(it):
    sec = it.get('section')
    if sec == 'reading':
        return 'reading~' + str(it.get('passage_id') or 0)
    if sec == 'writing':
        return 'writing~' + str(it.get('part') or 'A')
    return (sec or 'misc') + '~0'

answers = {}
units = 0
for rec in recs:
    groups = {}
    for it in rec.get('items', []):
        k = gkey(it)
        g = groups.setdefault(k, {'section': it.get('section'), 'nums': {}})
        if it.get('type') == 'question' and it.get('number') is not None:
            a = it.get('answer')
            if a and isinstance(a, str) and len(a) == 1 and a.isalpha():
                g['nums'][str(it['number'])] = a
    for k, g in groups.items():
        if g['nums']:
            unitId = f"{rec['id']}~{k}"
            answers[unitId] = dict(sorted(g['nums'].items(), key=lambda x: int(x[0])))
            units += 1

tmp = OUT + '.tmp'
with open(tmp, 'w', encoding='utf-8') as w:
    json.dump(answers, w, ensure_ascii=False, indent=2)
os.replace(tmp, OUT)

tot_q = sum(len(v) for v in answers.values())
print(f'written {OUT}')
print(f'units={units}  totalAnswers={tot_q}')
# 抽查
for uid in list(answers)[:3] + list(answers)[-3:]:
    print(' ', uid, '->', answers[uid])
