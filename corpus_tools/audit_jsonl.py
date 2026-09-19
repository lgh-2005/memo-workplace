# -*- coding: utf-8 -*-
"""Deep quality audit of generated exams_docx.jsonl."""
import json, re, sys
sys.stdout.reconfigure(encoding='utf-8')

P = r'D:\ai\opencode\momo\english-workbench\corpus\exams.jsonl'
recs = [json.loads(l) for l in open(P, encoding='utf-8')]
issues = []

print(f"{'yr':>4} {'items':>5} {'qs':>4} {'ue':>3}{'rd':>3}{'pb':>3}{'tr':>3}{'wr':>3} "
      f"{'blanks':>7} {'opts_ok':>7} {'pid_ok':>6} {'score':>6}")
for r in recs:
    y = r['meta']['year']
    items = r['items']
    ue = sum(1 for i in items if i['type'] == 'question' and i['section'] == 'use_of_english')
    rd = sum(1 for i in items if i['type'] == 'question' and i['section'] == 'reading')
    pb = sum(1 for i in items if i['type'] == 'question' and i['section'] == 'part_b' and i.get('number'))
    tr = sum(1 for i in items if i['type'] == 'question' and i['section'] == 'translation')
    wr = sum(1 for i in items if i['type'] in ('writing', 'question') and i['section'] == 'writing')
    # 完形挖空完整性：passage 里 __1__..__20__ 都在
    ue_pass = next((i for i in items if i['type'] == 'passage' and i['section'] == 'use_of_english'), None)
    blanks = 0
    if ue_pass:
        found = set(int(x) for x in re.findall(r'__(\d{1,2})__', ue_pass['text']))
        want = set(range(1, ue + 1))
        blanks = len(want & found)
        if found - want:
            issues.append(f"{y}: 完形正文含多余挖空 {sorted(found-want)[:5]}")
        if want - found:
            issues.append(f"{y}: 完形正文缺挖空 {sorted(want-found)[:5]}")
    # 选项完整性：每道客观题 4 项
    bad_opt = 0
    for i in items:
        if i['type'] == 'question' and i['section'] in ('use_of_english', 'reading') and i.get('number'):
            o = i.get('options') or {}
            if set(o.keys()) != {'A', 'B', 'C', 'D'} or any(not v.strip() for v in o.values()):
                bad_opt += 1
    if bad_opt:
        issues.append(f"{y}: {bad_opt} 道客观题选项不全")
    # reading passage_id
    bad_pid = 0
    rdqs = [i for i in items if i['type'] == 'question' and i['section'] == 'reading']
    for i in rdqs:
        if not i.get('passage_id'):
            bad_pid += 1
    # 翻译题长度
    short_tr = sum(1 for i in items if i['section'] == 'translation' and i['type'] == 'question'
                   and len(i.get('text') or '') < 40)
    if short_tr:
        issues.append(f"{y}: {short_tr} 道翻译题干过短")
    # 分值
    total = sum(i.get('score') or 0 for i in items if i['type'] in ('question', 'writing'))
    flag = ''
    if y >= 2005:
        if (ue, rd, pb, tr, wr) != (20, 20, 5, 5, 2): flag = ' <<'
    else:
        if y in (1999, 2000):
            if (ue, rd, tr, wr) != (10, 20, 5, 1): flag = ' <<'
        else:
            if (ue, rd, tr, wr) != (20, 20, 5, 1): flag = ' <<'
    print(f"{y:>4} {len(items):>5} {r['meta']['questions']:>4} {ue:>3}{rd:>3}{pb:>3}{tr:>3}{wr:>3} "
          f"{blanks:>7} {('bad:'+str(bad_opt)) if bad_opt else 'ok':>7} {('bad:'+str(bad_pid)) if bad_pid else 'ok':>6} {total:>6}{flag}")

print()
if issues:
    print("== ISSUES ==")
    for x in issues[:30]:
        print(' -', x)
else:
    print("== ALL CLEAN ==")
