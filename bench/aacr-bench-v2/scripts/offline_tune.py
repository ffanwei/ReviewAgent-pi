"""Offline tuning for per-PR budget/ranking + deterministic reflection filters.

No model calls. Reuses existing metrics (judge matches) and result JSONs.
Filters/rankings only use pre-judge features: path, line, severity, confidence,
category, rule, title/description/evidence length, diff scope.
"""
import json, re
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
        cand = buckets.get(key)
        f = cand.pop() if cand else {}
        g['_sev'] = f.get('severity'); g['_conf'] = f.get('confidence') or 0
        g['_cat'] = f.get('category') or ''; g['_rule'] = f.get('rule') or ''
        g['_ev'] = len(f.get('evidence') or []); g['_desc'] = len(str(f.get('failure_scenario') or f.get('description') or ''))
        g['_title'] = str(f.get('summary') or f.get('title') or '')

def rank_val(g, key):
    sev = RANK.get(g.get('_sev'), 0); conf = g.get('_conf') or 0; cw = CATW.get(g.get('_cat'), 0)
    if key == 'sev_conf': return (sev, conf, cw)
    if key == 'sev_cat_conf': return (sev, cw, conf)
    if key == 'cat_sev_conf': return (cw, sev, conf)
    if key == 'conf_sev': return (conf, sev, cw)
    if key == 'score_a': return (sev * 2 + conf * 2 + cw, conf)
    if key == 'score_b': return (sev + conf * 3 + cw * 0.5, conf)
    raise ValueError(key)

RANKINGS = ['sev_conf', 'sev_cat_conf', 'cat_sev_conf', 'conf_sev', 'score_a', 'score_b']

def keep(g, filt, iid):
    path = g.get('path', ''); line = g.get('from_line')
    if filt in ('scope', 'scope_config', 'combo') and not in_scope(scopes[iid], path, line): return False
    if filt in ('config', 'scope_config', 'combo') and is_config(path): return False
    if filt in ('conf50', 'combo') and (g.get('_conf') or 0) < 0.5: return False
    if filt in ('desc40', 'combo') and g.get('_desc', 0) < 40: return False
    if filt == 'ev1' and g.get('_ev', 0) < 2: return False
    if filt == 'style_title' and any(k in g.get('_title', '') for k in ('建议', '考虑', '风格', '命名', '格式', '注释')): return False
    return True

FILTERS = ['none', 'scope', 'config', 'scope_config', 'conf50', 'desc40', 'style_title', 'combo']

def evaluate(filt, key, maxn, cap):
    exp = kept = matched = 0; cov = 0; gen_gt = 0
    for row in rows:
        iid = row['instance_id']
        cs = [c for c in (row.get('comments') or []) if c.get('note')]
        exp += len(cs); gtpaths = {c.get('path') for c in cs}
        gens = [g for g in (row.get('generated_comments') or []) if keep(g, filt, iid)]
        gens = sorted(gens, key=lambda g: rank_val(g, key), reverse=True)
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
    return {'filt': filt, 'rank': key, 'maxn': maxn, 'cap': cap, 'kept': kept, 'matched': matched,
            'covered': cov, 'P': round(P, 4), 'R': round(R, 4), 'B': round(B, 4),
            'onGT': round(gen_gt / kept, 3) if kept else 0.0}

def baseline():
    exp = kept = matched = 0; cov = 0
    for row in rows:
        exp += sum(1 for c in (row.get('comments') or []) if c.get('note'))
        covered = set()
        for g in row.get('generated_comments') or []:
            kept += 1
            new = [i for i in (g.get('matched_gt_indices') or []) if i not in covered]
            if new: matched += 1
            covered.update(g.get('matched_gt_indices') or [])
        cov += len(covered)
    P = matched / kept; R = cov / exp; B = 2 * P * R / (P + R)
    return {'kept': kept, 'matched': matched, 'covered': cov, 'P': round(P, 4), 'R': round(R, 4), 'B': round(B, 4)}

results = []
for filt in FILTERS:
    for key in RANKINGS:
        for maxn in [None, 4, 6, 8, 10, 12, 15, 20]:
            for cap in [None, 2, 3, 4]:
                results.append(evaluate(filt, key, maxn, cap))
base = baseline()
best_B = max(results, key=lambda r: (r['B'], r['P']))
best_R15 = max([r for r in results if r['R'] >= 0.15], key=lambda r: r['B'], default=None)
best_R12 = max([r for r in results if r['R'] >= 0.12], key=lambda r: r['B'], default=None)
best_P_R15 = max([r for r in results if r['R'] >= 0.15], key=lambda r: (r['P'], r['B']), default=None)
out = {'baseline': base, 'best_B': best_B, 'best_R15': best_R15, 'best_R12': best_R12, 'best_P_R15': best_P_R15}
Path('.pilot-logs/offline-tune.json').write_text(json.dumps({'best': out, 'all': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('baseline', base)
for name, key in [('best_B', 'best_B'), ('best_R15', 'best_R15'), ('best_R12', 'best_R12'), ('best_P_R15', 'best_P_R15')]:
    print(name, out[key])
