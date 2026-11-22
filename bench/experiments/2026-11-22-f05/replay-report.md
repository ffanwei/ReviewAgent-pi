# F-05 回放结果（独立证伪核验）

口径：v3 iterF91 的 F-04 `unverified` findings；每条 finding 一次 one-shot；
输入 = finding + 行号附近 80 行片段（max 8k 字符）；标签按 `(file, line)` 对齐 judge。

## 汇总

| 模型 | 样本 | pass | reject | uncertain | 请求失败 | 解析失败 | 拒绝 TP | 拒绝 FP | 丢掉 GT | tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | 103 | 44 | 2 | 57 | 0 | 0 | 1 | 1 | 2 | 240,050 |
| deepseek-v4-pro | 103 | 54 | 0 | 49 | 0 | 0 | 0 | 0 | 0 | 282,893 |

## 核验子集指标（仅被核验的 findings，不是全量 320）

| 模型 | 阶段 | generated | matched | covered GT | P | R | B |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | 核验前 | 103 | 30 | 39 | 29.1% | 6.6% | 10.8% |
| deepseek-v4.1-flash | 拒绝后 | 101 | 29 | 37 | 28.7% | 6.3% | 10.3% |
| deepseek-v4-pro | 核验前 | 103 | 30 | 39 | 29.1% | 6.6% | 10.8% |
| deepseek-v4-pro | 拒绝后 | 103 | 30 | 39 | 29.1% | 6.6% | 10.8% |

## 判定分布

| 模型 | pass | reject | uncertain: 片段不足 | excerpt 不可得 | 传输失败 | 解析失败 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | 44 | 2 | 57 | 0 | 0 | 0 |
| deepseek-v4-pro | 54 | 0 | 49 | 0 | 0 | 0 |

## 被拒绝的 findings


### deepseek-v4.1-flash（2 条）

| instance | file:line | judge | reason |
| --- | --- | --- | --- |
| cline__cline@419534c | src/core/task/index.ts:1329 | FP | The excerpt at 1324-1327 clearly shows the index is computed INSIDE the .then callback via findLastIndex on the current getClineMessages(), with a -1 guard, not |
| mpv-player__mpv@dbd327d | misc/io_utils.c:43 | TP | The excerpt shows open(template, O_RDWR\|O_CREAT\|O_EXCL\|flags, 0600) and retries on EEXIST (lines 52-54). Thus predictable candidate names do not allow symlin |

### deepseek-v4-pro（0 条）

无。
