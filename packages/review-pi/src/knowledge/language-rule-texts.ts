/**
 * 语言缺陷清单正文（ADR-0118）：从 open-code-review 的语言规则中**只保留
 * 缺陷导向条目**，翻译为中文；拼写、命名、注释、格式、风格类条目已删除。
 *
 * 只支持 AST 已支持的 5 种语言（java / typescript / python / go / cpp）。
 * 规则在 Phase 5（候选生成）按组/变更文件注入，不进入 system prompt。
 */
export const LANGUAGE_RULE_TEXTS = {
  java: `#### 空值与契约
- 可能返回 null 的调用结果、字段或集合元素被直接解引用；Optional.get 未先 isPresent；equals/hashCode 依赖的字段可为空。
- 拆箱时可能为 null 的包装类型直接参与运算。

#### 逻辑与边界
- if / 三元条件取反、优先级或短路求值写错，导致分支与意图不符。
- 数组、List、String 的下标与长度边界；循环首尾元素、空集合。
- switch 缺少 break 造成意外穿透；有意的穿透没有注释说明。
- 可能无法终止的循环或递归；return/break/continue 用错层级。

#### 异常与错误路径
- 捕获异常后静默吞掉、只打印不处理、丢失 cause。
- catch 范围过宽，把不该处理的异常也吞掉。
- finally / 资源关闭覆盖主异常，或错误路径没有释放资源。
- 在 finally 中 return/throw 覆盖原有结果。

#### 并发
- check-then-act 竞态；需要原子性的多步复合操作没有同步。
- 双重检查锁的单例/缓存实现缺少 volatile 或正确的同步。
- 多线程环境修改 ArrayList / HashMap 等非线程安全集合，或共享可变状态无同步。
- 不报：方法内局部变量、只读访问、单线程上下文、不可变对象、已有正确同步的代码。

#### 资源与生命周期
- 流、连接、锁、事务未在所有可达路径关闭；try-with-resources 可用却手写 close。
- 在循环内 defer/close，延迟到方法结束才释放。

#### 性能
- 循环内执行数据库查询或远程调用；N+1 查询。
- 无分页处理大数据集；嵌套循环 O(n^2) 且存在明显更优解。

#### 安全
- SQL、命令、路径、模板由不可信输入拼接，未参数化/校验/转义。
- 日志或异常泄露密钥、令牌、个人信息。
- 不可信数据的反序列化，或使用弱随机数生成安全令牌。`,

  typescript: `#### 空值与类型
- 可能为 null/undefined 的值被直接解引用、解构或调用；非空断言 ! 用在可能为空的位置。
- any / 类型断言掩盖了会在运行时失败的形状；可选链之后仍假设对象存在。

#### 异步与 Promise
- async 函数没有处理 rejection；Promise 未 await、未 catch 或返回后被丢弃。
- 相互独立的异步任务被串行 await，造成不必要的延迟（性能）。
- 在 async 函数中执行阻塞操作，卡住事件循环。
- 错误处理缺失或把失败转成默认值，掩盖真实错误。

#### 比较与转换
- == / != 引发隐式类型转换，导致与意图不符的比较结果。
- NaN、-0、浮点相等；parseInt 缺少 radix；JSON.parse 未处理异常。
- 数值/字符串转换失败后继续使用结果。

#### 资源与生命周期
- 事件监听、定时器、订阅、AbortController 未在卸载/错误路径清理。
- 闭包捕获循环变量或可变外部状态，回调看到的是最终值。
- 组件卸载后仍 setState 或写外部状态。

#### React
- Hooks 在条件/循环中调用，破坏调用顺序。
- useEffect 依赖缺失、清理缺失，或造成重复订阅/无限循环。
- render 期间执行副作用；在组件内部定义新组件导致状态丢失。

#### 安全
- innerHTML、document.write 插入未转义的用户输入；eval / Function / 字符串形式 setTimeout。
- 修改原生对象原型；密钥、令牌写进源码或日志。
- 服务端请求的 URL/路径由不可信输入拼接，造成 SSRF 或路径穿越。

#### 运行时边界
- 数组/切片下标越界；空数组取首元素；除零或 NaN 传播。`,

  python: `#### 可变默认值与共享状态
- def f(x=[]) / def f(x={}) 这类可变默认参数；类级可变属性被所有实例共享。
- 模块级可变全局跨请求/线程修改；闭包捕获循环变量。

#### 边界与空值
- 空 list/str/dict 直接取 [0]、max/min 或切片；下标/切片越界。
- 可返回 None 的调用结果未判空就使用；dict[k] 未处理缺键。
- 浮点 == 比较；// 造成意外截断；除数为零。

#### 异常
- 裸 except；过宽 except；捕获后 pass 或只打印不处理。
- raise 新异常时丢失原始 traceback（应 from err）。
- assert 校验外部输入（python -O 下会被移除）。

#### 身份与相等
- 用 is / is not 比较字符串、数字、元组等字面量。
- 用 == True / == False 判断，truthy 值会得到意外结果。

#### 资源
- 文件、socket、锁、数据库连接未用 with，异常路径泄漏。
- 生成器/迭代器长期持有资源。

#### 性能
- 循环内用 += 拼字符串；list 上反复做成员测试；循环内重复编译正则或重复属性查找。
- logging 使用 f-string 而不是惰性格式化。

#### 并发与异步
- check-then-act 竞态；共享可变状态无锁。
- async def 中调用阻塞 I/O、time.sleep、requests 或 CPU 密集任务。
- create_task 后不 await，异常被吞掉；任务生命周期无人管理。

#### 安全
- eval / exec / compile 处理不可信输入；subprocess 使用 shell=True 拼接输入。
- pickle / marshal / yaml.load 处理不可信数据；SQL 字符串拼接。
- 密钥、令牌、个人信息进日志；用 random / md5 / sha1 做安全用途；路径拼接导致穿越。`,

  go: `#### 错误、panic 与契约
- 返回的 error 被忽略、覆盖或转成默认成功值；best-effort 必须能证明失败是安全的。
- 需要 errors.Is / errors.As 时用 %v 丢掉了 cause；包装 nil；公开边界泄露内部错误。
- request / worker / library / cleanup 路径使用 panic、log.Fatal、os.Exit，而本可返回错误。
- defer 覆盖主错误、吞掉 Close/Commit/Rollback 错误，或清理失败后仍返回成功。

#### nil、接口与值语义
- typed nil 存入接口后当非 nil 使用；nil map 写入；nil channel 永久阻塞；nil 指针解引用。
- 复制包含 Mutex/RWMutex/Once/atomic 等不可复制状态的值。
- 值接收者或拷贝只修改副本，而调用方期望共享状态。
- sync.Once 用于失败后需要重试的工作。

#### context、goroutine 与取消
- request 作用域使用 Background/TODO；context 存进 struct；cancel 未调用。
- 阻塞 I/O、等待、重试、select 缺少超时/取消，可能永久挂起。
- goroutine 可能永久等待 channel/锁/I/O 而无法退出；错误无人观察。
- 闭包捕获循环变量或可变外部状态（注意 go 1.22 前后的语义差异）。

#### channel、锁与共享状态
- 并发读写 map/slice/指针/计数器无同步；check-then-act 交错。
- 持锁执行 I/O、回调、网络/数据库调用或长计算；RLock 下修改数据。
- 多个关闭者、向已关闭 channel 发送、重复关闭；select default 忙等或丢任务。
- WaitGroup 的 Add 与 Wait 竞态、漏 Done、复制后使用、计数无法归零。

#### 定时器与资源
- ticker/timer 在工作结束后仍在运行并持有状态；reset/stop 的版本语义处理错误。
- http body、sql.Rows、文件、连接、压缩流、事务未在所有路径关闭；rows.Err 未检查。
- 循环内 defer 延迟关闭文件/连接/行/锁/事务到函数返回。

#### 集合、切片与数值边界
- 返回/缓存 slice 或 buffer，底层数组随后被复用或修改，导致数据被串改。
- append 到与调用方共享底层数组的 slice；保留大 buffer 的小切片。
- 下标、切片、长度计算越界；整数转换/溢出/负值转成巨大分配或偏移。

#### 安全边界
- SQL、命令、URL、路径、模板、正则由不可信输入拼接，缺少参数化/校验/转义/白名单。
- 路径穿越、不安全解压、临时文件权限；SSRF 或敏感头跨主机转发。
- 密钥/令牌/个人信息进日志或错误；math/rand 用于安全场景；unsafe/reflect/cgo 无边界检查。`,

  cpp: `#### 资源与所有权
- new/delete 不配对；异常路径泄漏；用裸指针管理动态内存。
- unique_ptr/shared_ptr/weak_ptr 误用；shared_ptr 循环引用；所有权不清晰导致重复释放。
- RAII 缺失：资源获取后没有在所有路径释放。

#### 空值与生命周期
- 空指针解引用；悬垂引用/迭代器；返回局部变量或临时对象的引用。
- move 之后继续使用对象；对象切片；迭代器在容器修改后失效。

#### 边界与未定义行为
- 数组/vector/string 下标越界；指针算术越界；越界 memcpy/strcpy。
- 有符号整数溢出；除零；未初始化变量；格式化字符串与参数不匹配。
- 释放后使用、重复释放、跨线程共享生命周期不明确的对象。

#### 异常安全
- catch (...) 吞掉所有异常；析构函数抛异常；异常路径资源未释放或状态不一致。
- 捕获后继续使用已失效的对象。

#### 并发
- 数据竞争；锁顺序死锁；锁未释放；条件变量虚假唤醒/丢失唤醒。
- 原子与非原子访问混用；共享对象无同步。

#### 安全
- 缓冲区溢出；命令/路径/SQL 拼接不可信输入；整数截断导致分配过小。
- 不可信数据的反序列化；使用弱随机数生成安全令牌。

#### 性能
- 循环内拷贝大对象（应按 const 引用传递）；不必要的 shared_ptr 拷贝。
- O(n^2) 查找且存在明显更优解；循环内重复分配。`,
} as const;

export type AstLanguage = keyof typeof LANGUAGE_RULE_TEXTS;
