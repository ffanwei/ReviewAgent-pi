"""Stability check for the offline budget/ranking/filter tuning.

Splits the 91 samples into two folds, evaluates the full-grid winners on each,
and runs a small tune-on-one-fold / evaluate-on-the-other check.
"""
import json, re, hashlib
from collections import defaultdict
from pathlib import Path

RANK = {'P0': 4, 'P1': 3, 'P2': 2, 'P3': 1}
CATW = {'可靠性': 3.0, '安全': 3.0, '性能': 2.0, '可维护': 1.0, '可读性': 0.5,
        '可移植': 1.0, '可测试性': 1.0, '可维护性': 0.5}
CONFIG_PATTERNS = ["**/*.md", "**/*.lock", "**/*.snap", "**/package-lock.json",
    "**/pnpm-lock.yaml", "**/yarn.lock", "**/uv.lock", "**/pixi.lock", "**/poetry.lock",
    "**/build/**", "**/dist/**", "**/generated/**", "**/testdata/**", "**/baselines/**",
    "**/__snapshots__/**", "**/*.min.js", "**/*.map", "**/*.vocab.json", "**/*.interp",
    "**/.github/workflows/**", "**/*.yml", "**/*.yaml"]
def glob_re(p):
    out = ''; i = 0
    while i < len(p):
        if p.startswith('**/', i): out += '(?:.*/)?'; i += 3
        elif p.startswith('**', i): out += '.*'; i += 2
        elif p[i] == '*': out += '[^/]*'; i += 1
        elif p[i] == '?': out += '[^/]'; i += 1
        else: out += re.escape(p[i]); i += 1
    return re.compile('^' + out + '$')
CONFIG_RE = [glob_re(p) for p in CONFIG_PATTERNS]
def is_config(path): return any(r.match(path) for r in CONFIG_RE)

CONTEXT = 10
def diff_scope(path):
    files = {}
    if not path.is_file(): return files
    cur = None
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if line.startswith('diff --git '):
            m = re.search(r' b/(.+)$', line); cur = m.group(1) if m else None
            if cur: files.setdefault(cur, {'all': [], 'ctx': []})
        elif line.startswith('+++ '):
            p = line[4:].strip()
            if p == '/dev/null':
                if cur: files[cur] = None
            else:
                if p.startswith('b/'): p = p[2:]
                if cur is None: cur = p
                files.setdefault(p, {'all': [], 'ctx': []})
        elif line.startswith('@@ '):
            m = re.match(r'@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', line)
            if m and cur and files.get(cur) is not None:
                start = int(m.group(1)); count = int(m.group(2) or 1)
                last = start if count <= 0 else start + count - 1
                files[cur]['all'].append((start, last))
                files[cur]['ctx'].append((max(1, start - CONTEXT), last + CONTEXT))
    return files
def in_scope(files, path, line):
    if not files: return True
    if path not in files: return False
    if files[path] is None: return True
    if not line or line <= 0: return True
    return any(a <= line <= b for a, b in files[path]['ctx'])

ids = {json.loads(l)['instance_id'] for l in open('data/aacr_bench_v2_ocr_rp_ok.jsonl', encoding='utf-8')}
m = json.load(open('results/aacr_bench_v2/reviewpi/arm2/metrics_claude_20261116_102219.json', encoding='utf-8'))
rows = [r for r in m['eval_res'] if r['instance_id'] in ids]
scopes = {}
for row in rows:
    sid = row['instance_id'].replace('/', '__')
    scopes[row['instance_id']] = diff_scope(Path(f'results/aacr_bench_v2/reviewpi/arm2/.reviewpi/diff/{sid}.diff'))
    res = json.load(open(f'results/aacr_bench_v2/reviewpi/arm2/{sid}.json', encoding='utf-8'))
    buckets = defaultdict(list)
    for f in res.get('review_output') or []:
        note = '\n'.join(p for p in [f.get('summary', ''), f.get('failure_scenario', '')] if p).strip()
        buckets[(f.get('file', ''), f.get('line'), note)].append(f)
    for g in row.get('generated_comments') or []:
        key = (g.get('path', ''), g.get('from_line'), g.get('note', ''))
        cand = buckets.get(key); f = cand.pop() if cand else {}
        g['_sev'] = f.get('severity'); g['_conf'] = f.get('confidence') or 0
        g['_cat'] = f.get('category') or ''; g['_ev'] = len(f.get('evidence') or [])
        g['_desc'] = len(str(f.get('failure_scenario') or f.get('description') or '')); g['_title'] = str(f.get('summary') or f.get('title') or '')

def rv(g, key):
    sev = RANK.get(g.get('_sev'), 0); conf = g.get('_conf') or 0; cw = CATW.get(g.get('_cat'), 0)
    return {'sev_conf': (sev, conf, cw), 'sev_cat_conf': (sev, cw, conf),
            'cat_sev_conf': (cw, sev, conf), 'conf_sev': (conf, sev, cw),
            'score_a': (sev * 2 + conf * 2 + cw, conf),
            'score_b': (sev + conf * 3 + cw * 0.5, conf)}[key]
def keep(g, filt, iid):
    path = g.get('path', ''); line = g.get('from_line')
    if filt in ('scope', 'scope_config', 'combo') and not in_scope(scopes[iid], path, line): return False
    if filt in ('config', 'scope_config', 'combo') and is_config(path): return False
    if filt in ('conf50', 'combo') and (g.get('_conf') or 0) < 0.5: return False
    if filt in ('desc40', 'combo') and g.get('_desc', 0) < 40: return False
    if filt == 'ev1' and g.get('_ev', 0) < 2: return False
    if filt == 'style_title' and any(k in g.get('_title', '') for k in ('建议', '考虑', '风格', '命名', '格式', '注释')): return False
    return True
def evaluate(subset, filt, key, maxn, cap):
    exp = kept = matched = 0; cov = 0; gen_gt = 0
    for row in subset:
        iid = row['instance_id']
        cs = [c for c in (row.get('comments') or []) if c.get('note')]
        exp += len(cs); gtpaths = {c.get('path') for c in cs}
        gens = sorted([g for g in (row.get('generated_comments') or []) if keep(g, filt, iid)], key=lambda g: rv(g, key), reverse=True)
        chosen = []; perfile = defaultdict(int)
        for g in gens:
            if cap is not None and perfile[g.get('path')] >= cap: continue
            chosen.append(g); perfile[g.get('path')] += 1
        if maxn is not None: chosen = chosen[:maxn]
        covered = set()
        for g in chosen:
            kept += 1
            if g.get('path') in gtpaths: gen_gt += 1
            new = [i for i in (g.get('matched_gt_indices') or []) if i not in covered]
            if new: matched += 1
            covered.update(g.get('matched_gt_indices') or [])
        cov += len(covered)
    P = matched / kept if kept else 0.0; R = cov / exp if exp else 0.0
    B = 2 * P * R / (P + R) if P + R else 0.0
    return {'kept': kept, 'P': round(P, 4), 'R': round(R, 4), 'B': round(B, 4), 'onGT': round(gen_gt / kept, 3) if kept else 0.0}

def baseline(subset):
    exp = kept = matched = 0; cov = 0
    for row in subset:
        exp += sum(1 for c in (row.get('comments') or []) if c.get('note'))
        covered = set()
        for g in row.get('generated_comments') or []:
            kept += 1
            new = [i for i in (g.get('matched_gt_indices') or []) if i not in covered]
            if new: matched += 1
            covered.update(g.get('matched_gt_indices') or [])
        cov += len(covered)
    P = matched / kept; R = cov / exp; B = 2 * P * R / (P + R)
    return {'kept': kept, 'P': round(P, 4), 'R': round(R, 4), 'B': round(B, 4)}

fold_a = [r for r in rows if int(hashlib.md5(r['instance_id'].encode()).hexdigest(), 16) % 2 == 0]
fold_b = [r for r in rows if int(hashlib.md5(r['instance_id'].encode()).hexdigest(), 16) % 2 == 1]
print('folds', len(fold_a), len(fold_b))

params = [
    ('best_B', 'scope', 'cat_sev_conf', 6, 4),
    ('best_R15', 'scope_config', 'cat_sev_conf', 15, None),
    ('best_P_R15', 'scope_config', 'conf_sev', 12, None),
    ('budget_only', 'none', 'sev_conf', 8, 3),
]

def tune(subset):
    best = None
    for filt in ['none', 'scope', 'scope_config']:
        for key in ['sev_conf', 'sev_cat_conf', 'cat_sev_conf', 'conf_sev', 'score_a']:
            for maxn in [4, 6, 8, 10, 15]:
                for cap in [None, 3, 4]:
                    r = evaluate(subset, filt, key, maxn, cap)
                    if best is None or (r['B'], r['P']) > (best[-1]['B'], best[-1]['P']):
                        best = (filt, key, maxn, cap, r)
    return best

print('\nfull-set')
print('baseline', baseline(rows))
for name, filt, key, maxn, cap in params:
    print(name, filt, key, maxn, cap, evaluate(rows, filt, key, maxn, cap))

print('\nfold A')
print('baseline', baseline(fold_a))
for name, filt, key, maxn, cap in params:
    print(name, evaluate(fold_a, filt, key, maxn, cap))
print('\nfold B')
print('baseline', baseline(fold_b))
for name, filt, key, maxn, cap in params:
    print(name, evaluate(fold_b, filt, key, maxn, cap))

print('\nCV')
for train_name, train, test_name, test in [('A', fold_a, 'B', fold_b), ('B', fold_b, 'A', fold_a)]:
    best = tune(train)
    print(f'tuned on {train_name}', best[:4], 'train', best[4], 'test on', test_name, evaluate(test, *best[:4]))
