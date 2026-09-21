# -*- coding: utf-8 -*-
r"""生成六级真题记录并合并进 corpus/exams.jsonl（v2.7.1）。

· 逐份 docx 解析卷面 → items（cet6_docx.parse_paper）
· 从对应答案解析 PDF 抽取客观题答案 → 回填 answer 字段
· 计分（六级标准：听力 25×1 + 选词 10×0.5? → 采用「每题分值」口径见 SCORE）
· 记录带 track='cet6'，id 稳定（sha1 文件名前 12 位）
· 幂等：按 id 覆盖（不动 kaoyan1 记录）
"""
import json
import os
import re
import sys
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.stdout.reconfigure(encoding='utf-8')

import cet6_docx as C6
import cet6_answers as A

DOCX_DIR = r'D:\download\cet6\text'
ANS_DIR = r'D:\download\cet6\answer'
EXAMS = os.path.join(ROOT, 'corpus', 'exams.jsonl')

NAME_RE = re.compile(r'英语六级(\d{4})年(\d{1,2})月第(\d)套')

# 六级计分（710 分制常用换算前的「卷面分」口径）：听力 25×1、选词 10×0.5、
# 长篇匹配 10×1、仔细阅读 10×2（仅供参考展示，非官方折算）
SECTION_SCORE = {'listening': 1.0, 'banked_cloze': 0.5, 'long_match': 1.0,
                 'reading': 2.0, 'writing': 15.0, 'translation': 15.0}


def answer_letter_set(section):
    # 选词填空与长篇匹配的答案都是「段落/词池字母」（A–O 乃至 A–R）
    if section in ('banked_cloze', 'long_match'):
        return set('ABCDEFGHIJKLMNOPQRS')
    return set('ABCD')


def is_objective(section):
    return section in ('listening', 'banked_cloze', 'long_match', 'reading')


def build_record(fn, answers):
    m = NAME_RE.search(fn)
    year, month, setno = int(m.group(1)), int(m.group(2)), int(m.group(3))
    paras = C6.docx_paras(os.path.join(DOCX_DIR, fn))
    items = C6.parse_paper(year, month, setno, paras)

    for it in items:
        if it['type'] != 'question':
            continue
        sec = it['section']
        if not is_objective(sec):
            continue
        n = it.get('number')
        if n is None:
            continue
        let = answers.get(n)
        if let and let in answer_letter_set(sec):
            it['answer'] = let
        it['qtype'] = '匹配' if sec == 'long_match' else '单选'
        it['answerMode'] = '涂卡'
        it['score'] = SECTION_SCORE.get(sec)

    # 主观题标注
    for it in items:
        if it['type'] == 'writing':
            it['qtype'] = '作文'
            it['answerMode'] = '作文纸'
            it['score'] = SECTION_SCORE['writing']
            it['part'] = 'A'
        if it['section'] == 'translation' and it['type'] == 'question':
            it['qtype'] = '解答'
            it['answerMode'] = '书写'
            it['score'] = SECTION_SCORE['translation']

    # 排序：板块按卷面顺序，条目「先原文/题面，后题目」
    sec_order = ['writing', 'listening', 'banked_cloze', 'long_match', 'reading', 'translation']
    items.sort(key=lambda x: (sec_order.index(x['section']) if x['section'] in sec_order else 99))

    def sec_rank(it):
        s = sec_order.index(it['section']) if it['section'] in sec_order else 99
        t = 0 if it['type'] in ('passage', 'writing') else 1
        return (s, t)

    items.sort(key=sec_rank)

    qs = [x for x in items if x['type'] == 'question' and x['number'] is not None]
    by_qtype = {}
    for q in qs:
        by_qtype[q['qtype']] = by_qtype.get(q['qtype'], 0) + 1
    answered = sum(1 for q in qs if q.get('answer'))

    rec = {
        'id': hashlib.sha1(fn.encode('utf-8')).hexdigest()[:12],
        'rtype': 'qa_set',
        'track': 'cet6',
        'title': f'{year} 年 {month} 月英语六级真题（第 {setno} 套）',
        'text': '',
        'items': items,
        'meta': {
            'year': year, 'month': month, 'set': setno, 'track': 'cet6',
            'chars': sum(len(x.get('text') or '') for x in items),
            'questions': len(qs),
            'answered': answered,
            'by_qtype': by_qtype,
            'total_score': sum(x.get('score') or 0 for x in qs),
        },
        'source': {
            'file': fn, 'category': '真题', 'parser': 'cet6-v271',
            'imported_at': '2026-09-21T18:00:00', 'managed': 'manual',
            'origin': 'local_docx', 'answerPdf': os.path.basename(
                f'英语六级{year}年{month}月第{setno}套真题及答案解析（整卷）.pdf'),
        },
    }
    return rec


def main():
    files = sorted(f for f in os.listdir(DOCX_DIR) if f.endswith('.docx'))
    new = []
    report = []
    for fn in files:
        m = NAME_RE.search(fn)
        if not m:
            continue
        year, month, setno = int(m.group(1)), int(m.group(2)), int(m.group(3))
        apdf = os.path.join(ANS_DIR, f'英语六级{year}年{month}月第{setno}套真题及答案解析（整卷）.pdf')
        answers = A.extract_answers(apdf) if os.path.exists(apdf) else {}
        rec = build_record(fn, answers)
        new.append(rec)
        secs = {}
        for it in rec['items']:
            secs.setdefault(it['section'], 0)
            if it['type'] == 'question' and it['number'] is not None:
                secs[it['section']] += 1
        report.append((rec['title'], rec['meta']['questions'], rec['meta']['answered'], secs))

    # 合并：保留现有 kaoyan1（及一切非 cet6-新 id），覆盖同 id 的 cet6
    existing = []
    if os.path.exists(EXAMS):
        existing = [json.loads(l) for l in open(EXAMS, encoding='utf-8') if l.strip()]
    new_ids = {r['id'] for r in new}
    keep = [r for r in existing if r.get('id') not in new_ids]
    merged = keep + new
    merged.sort(key=lambda r: (r.get('track') or 'kaoyan1',
                               r.get('meta', {}).get('year') or 0,
                               r.get('meta', {}).get('set') or 0,
                               r.get('id')))

    tmp = EXAMS + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as w:
        for r in merged:
            w.write(json.dumps(r, ensure_ascii=False) + '\n')
    os.replace(tmp, EXAMS)

    print(f'exams.jsonl: kept={len(keep)} new_cet6={len(new)} total={len(merged)}')
    for (title, q, ans, secs) in report:
        s = ' '.join(f'{k}:{v}' for k, v in secs.items())
        print(f'  {title}  q={q} ans={ans}  {s}')


if __name__ == '__main__':
    main()
