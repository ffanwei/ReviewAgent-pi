import type { PathRepairRecord } from "../contracts/run.js";

/**
 * Finding 路径修复：模型偶尔把 `file` 写错几个字符（大小写、分隔符、
 * 拼写 / 换位），下游按原始路径读源码行就会「读不到」，该条意见在 MCP
 * 报文里被丢掉，平台侧表现为「找不到源码行」。
 *
 * 纪律：
 * - 只在**已知文件全集**内修复（本遍 diff 的变更文件 / 全仓本组送检文件），
 *   修复结果一定是真实存在的路径，不扩大检视范围；
 * - 绝对路径、`..`、盘符一律不修（安全边界先于便利）；
 * - 精确匹配 → 宽松匹配（大小写 / 反斜杠 / `./` / Unicode NFC）是确定性修复；
 * - 宽松仍不中时才做有界编辑距离匹配；只有**唯一最佳**且差距明确才修，
 *   平局或证据不足保持原样（宁可报不出，也不把意见挂到别的文件上）；
 * - 扩展名不同不做模糊匹配（`.ts` → `.tsx` 是另一个文件，不是笔误）。
 */

export interface RepairFilePathsResult<T> {
  readonly items: readonly T[];
  readonly repairs: readonly PathRepairRecord[];
}

interface Universe {
  readonly exact: Set<string>;
  /** 宽松路径（小写 / `/` / NFC / 去 `./`）→ 规范路径（可能多个：大小写变体） */
  readonly loose: Map<string, string[]>;
  /** 宽松 basename → 规范路径（精确 basename 候选） */
  readonly byBasename: Map<string, string[]>;
}

/** 宽松路径键：只用于匹配，不用于落盘。 */
function loosePath(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

function basenameOf(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

function extensionOf(value: string): string {
  const base = basenameOf(value);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** 安全门：绝对路径 / 盘符 / `..` 段 / 空路径都不参与修复。 */
export function isRepairablePath(value: string): boolean {
  const text = value.trim();
  if (text === "") {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/") || text.startsWith("\\")) {
    return false;
  }
  return !text.split(/[\\/]+/).some((segment) => segment === "..");
}

function buildUniverse(knownFiles: readonly string[]): Universe {
  const exact = new Set<string>();
  const loose = new Map<string, string[]>();
  const byBasename = new Map<string, string[]>();
  for (const raw of knownFiles) {
    const canonical = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (canonical === "" || exact.has(canonical)) {
      continue;
    }
    exact.add(canonical);
    const key = loosePath(canonical);
    const entries = loose.get(key);
    if (entries === undefined) {
      loose.set(key, [canonical]);
    } else if (!entries.includes(canonical)) {
      entries.push(canonical);
    }
    const base = basenameOf(key);
    const byBase = byBasename.get(base);
    if (byBase === undefined) {
      byBasename.set(base, [canonical]);
    } else if (!byBase.includes(canonical)) {
      byBase.push(canonical);
    }
  }
  return { exact, loose, byBasename };
}

/** 有界编辑距离：长度差已超上限时直接失败，避免无意义的全矩阵。 */
function boundedDistance(left: string, right: string, max: number): number | undefined {
  if (Math.abs(left.length - right.length) > max) {
    return undefined;
  }
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const temp = previous[j] ?? 0;
      previous[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }
  const distance = previous[right.length] ?? Number.POSITIVE_INFINITY;
  return distance <= max ? distance : undefined;
}

function maxDistanceFor(path: string): number {
  if (path.length <= 12) {
    return 1;
  }
  return path.length <= 24 ? 2 : 3;
}

interface Resolution {
  readonly path: string;
  readonly distance: number;
}

function resolveOne(raw: string, universe: Universe): Resolution | undefined {
  if (!isRepairablePath(raw)) {
    return undefined;
  }
  const canonical = raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (universe.exact.has(canonical)) {
    return canonical === raw ? undefined : { path: canonical, distance: 0 };
  }
  const loose = loosePath(canonical);
  const looseHits = universe.loose.get(loose);
  if (looseHits !== undefined) {
    return looseHits.length === 1
      ? { path: looseHits[0] as string, distance: 0 }
      : undefined;
  }

  const maxDistance = maxDistanceFor(loose);
  const basename = basenameOf(loose);
  const extension = extensionOf(loose);
  const candidates = new Map<string, number>();

  const addCandidate = (candidate: string): void => {
    if (candidates.has(candidate)) {
      return;
    }
    const distance = boundedDistance(loose, loosePath(candidate), maxDistance);
    if (distance === undefined) {
      return;
    }
    // 扩展名不同 = 另一个文件，不是笔误（大小写已在 loosePath 归一）。
    if (extensionOf(candidate) !== extension) {
      return;
    }
    candidates.set(candidate, distance);
  };

  // 先看 basename 精确相同的候选（目录写错、文件名正确是最常见的形态）。
  for (const candidate of universe.byBasename.get(basename) ?? []) {
    addCandidate(candidate);
  }
  // basename 也写错时，才在长度窗口内做有界编辑距离比较。
  if (candidates.size === 0) {
    for (const [knownBase, paths] of universe.byBasename) {
      if (boundedDistance(basename, knownBase, maxDistance) === undefined) {
        continue;
      }
      for (const candidate of paths) {
        addCandidate(candidate);
      }
    }
  }

  if (candidates.size === 0) {
    return undefined;
  }
  let best: Resolution | undefined;
  let tie = false;
  for (const [path, distance] of candidates) {
    if (best === undefined || distance < best.distance) {
      best = { path, distance };
      tie = false;
    } else if (distance === best.distance) {
      tie = true;
    }
  }
  return best !== undefined && !tie ? best : undefined;
}

/**
 * 按已知文件全集修复 findings 的 `file`。返回保持原顺序的新数组与修复留痕；
 * 无需修复时返回原对象（不复制）。
 */
export function repairFilePaths<T extends { readonly file: string }>(
  findings: readonly T[],
  knownFiles: readonly string[],
): RepairFilePathsResult<T> {
  if (findings.length === 0 || knownFiles.length === 0) {
    return { items: findings, repairs: [] };
  }
  const universe = buildUniverse(knownFiles);
  const cache = new Map<string, Resolution | undefined>();
  const repairs: PathRepairRecord[] = [];
  const items = findings.map((finding) => {
    let resolution: Resolution | undefined;
    if (cache.has(finding.file)) {
      resolution = cache.get(finding.file);
    } else {
      resolution = resolveOne(finding.file, universe);
      cache.set(finding.file, resolution);
    }
    if (resolution === undefined || resolution.path === finding.file) {
      return finding;
    }
    repairs.push({
      from: finding.file,
      to: resolution.path,
      distance: resolution.distance,
    });
    return { ...finding, file: resolution.path };
  });
  return { items, repairs };
}
