# -*- coding: utf-8 -*-
"""
v2.6.3 真题库答案回填：
数据源 = data/answers_source/考研英语一历年真题答案汇编.md（懒笔记站整理）
产物   = corpus/exams.jsonl 中每道客观题 it['answer'] + data/answers.json（单元库标准答案）

口径：
- 客观题（完形/阅读/新题型的 ABCD）与写作 and 翻译（主观题）不写 it['answer']。
- 只对 options 含 A 的单选题写入字母；Part B 匹配题（options 为池/无）也写入字母。
- 答案来源为非官方公开转载，统一标注 source.answer_source。
"""
import json, os, re, sys, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, HERE)

MD = os.path.join(ROOT, 'data', 'answers_source', '考研英语一历年真题答案汇编.md')
EXAMS = os.path.join(ROOT, 'corpus', 'exams.jsonl')
ANSWERS = os.path.join(ROOT, 'data', 'answers.json')

# ---------- 1. 解析汇编 MD ----------
md = open(MD, encoding='utf-8').read()
blocks = re.split(r'\n(?=## \d{4} 年\n)', md)
blocks = [b for b in blocks if re.match(r'^## \d{4} 年\n', b)]

def parse_grid(block):
    """从「客观题答案」小节解析 题号->字母。"""
    i = block.find('### 客观题答案')
    if i < 0:
        return {}
    j = block.find('\n### ', i + 5)
    seg = block[i: j if j > 0 else len(block)]
    answers = {}
    # 表格行: | 答案 | A | D | ... |
    for m in re.finditer(r'^\|\s*答案\s*\|(.+?)\|\s*$', seg, re.M):
        letters = [c.strip() for c in m.group(1).split('|')]
        answers.setdefault('_grids', []).append(letters)
    # 表格行: | 题号 | 1 | 2 | ... |
    nums = []
    for m in re.finditer(r'^\|\s*题号\s*\|(.+?)\|\s*$', seg, re.M):
        nums.append([c.strip() for c in m.group(1).split('|')])
    out = {}
    for numrow, ansrow in zip(nums, answers.get('_grids', [])):
        for n, a in zip(numrow, ansrow):
            if re.fullmatch(r'\d+', n) and re.fullmatch(r'[A-H]', a):
                out[int(n)] = a
    # 反引号排序链/单行: `预给F → 41=B → ...` 或 `41=B → ...`
    for m in re.finditer(r'`([^`]+)`', seg):
        for mm in re.finditer(r'(\d+)\s*=\s*([A-H])', m.group(1)):
            out[int(mm.group(1))] = mm.group(2)
    return out

year_answers = {}
for b in blocks:
    year = int(re.match(r'^## (\d{4}) 年', b).group(1))
    year_answers[year] = parse_grid(b)

# ---------- 2. 校验：与 raw_all.json 对照（题号完整性） ----------
print('解析出的年份客观题数：')
for y in sorted(year_answers):
    print(f'  {y}: {len(year_answers[y])} 题')

# ---------- 3. 回填 exams.jsonl ----------
raw = open(EXAMS, 'rb').read()
recs = [json.loads(l) for l in raw.decode('utf-8').split('\n') if l.strip()]

filled = 0
missing = []
for rec in recs:
    y = rec.get('meta', {}).get('year')
    ans = year_answers.get(y, {})
    for it in rec.get('items', []):
        if it.get('type') not in ('question', 'writing'):
            continue
        num = it.get('number')
        if num is None:
            continue
        if it.get('section') in ('writing',):
            continue  # 主观题不填
        if num in ans:
            it['answer'] = ans[num]
            filled += 1
        elif it.get('options') and len(it['options']) >= 2:
            missing.append((y, num, it.get('section')))

print(f'\n客观题回填 {filled} 条')
print(f'仍有空答案的客观题（有 options 但未匹配）: {len(missing)}')
for m in missing[:60]:
    print('  MISSING', m)

# 写回（保持 CRLF + ensure_ascii=False，字节级可测）
tmp = EXAMS + '.tmp'
with open(tmp, 'wb') as w:
    w.write(('\r\n'.join(json.dumps(r, ensure_ascii=False) for r in recs) + '\r\n').encode('utf-8'))
os.replace(tmp, EXAMS)
print('\nwritten:', EXAMS)
