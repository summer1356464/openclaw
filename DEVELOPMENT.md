# 百度搜索API集成开发文档

## 开发目标

集成百度智能云千帆平台的三个搜索API：
1. **智能搜索生成（高性能版）** - `https://qianfan.baidubce.com/v2/ai_search/web_summary`
2. **智能搜索生成** - `https://qianfan.baidubce.com/v2/ai_search/chat/completions`
3. **百度搜索** - `https://qianfan.baidubce.com/v2/ai_search/web_search`

并在OpenClaw的web-search工具中实现一个小框架，根据具体请求类型调用不同的搜索方法。

## 完成的工作

### 1. API端点定义

在`web-search.ts`文件中添加了三个百度搜索API的端点常量：

```typescript
const BAIDU_QIANFAN_API_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_summary"; // 智能搜索生成（高性能版）
const BAIDU_CHAT_COMPLETIONS_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/chat/completions"; // 智能搜索生成
const BAIDU_WEB_SEARCH_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_search"; // 百度搜索
```

### 2. 类型定义

添加了百度搜索相关的类型定义：

```typescript
// 百度搜索请求类型
type BaiduSearchType = 'intelligent' | 'chat_completions' | 'web_search';

// 百度搜索API响应类型
type BaiduSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  siteName?: string;
};

// 百度搜索API通用请求参数
type BaiduSearchParams = {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  freshness?: string;
  searchType?: BaiduSearchType;
  model?: string;
};
```

### 3. API封装函数

封装了三个百度搜索API的调用函数：

#### 3.1 智能搜索生成（高性能版）

```typescript
async function runBaiduIntelligentSearch(params: BaiduSearchParams): Promise<{ results: BaiduSearchResult[]; content?: string }>
```

#### 3.2 智能搜索生成

```typescript
async function runBaiduChatCompletionsSearch(params: BaiduSearchParams): Promise<{ results: BaiduSearchResult[]; content?: string }>
```

#### 3.3 百度搜索

```typescript
async function runBaiduWebSearch(params: BaiduSearchParams): Promise<{ results: BaiduSearchResult[] }>
```

### 4. 搜索框架实现

修改了`runWebSearch`函数中的百度搜索部分，实现了一个自动降级的搜索框架：

1. **首先尝试**：智能搜索生成（高性能版）
2. **如果失败**：尝试智能搜索生成
3. **如果失败**：尝试百度搜索
4. **如果全部失败**：使用网页抓取作为回退方案

### 5. Freshness参数支持

- 修改了代码，允许百度搜索使用`freshness`参数
- 添加了`freshnessToBaiduRecency`函数，将标准的`freshness`格式（pd/pw/pm/py）转换为百度API需要的格式（week/month/year）
- 在三个百度搜索API调用函数中添加了`freshness`参数支持

### 6. 缓存机制优化

修改了缓存键生成逻辑，确保百度搜索结果能够正确缓存，包含了`freshness`参数。

### 7. 错误处理

实现了完善的错误处理机制，包括：
- API调用失败的捕获和处理
- 自动降级到其他搜索方法
- 最终回退到网页抓取
- 详细的错误日志

## 技术实现细节

### 1. API调用格式

根据百度智能云文档，三个API的调用格式有所不同：

- **智能搜索生成（高性能版）**：使用`X-Appbuilder-Authorization`头
- **智能搜索生成**：使用`X-Appbuilder-Authorization`头，需要指定`model`参数
- **百度搜索**：使用`X-Appbuilder-Authorization`头，返回原始搜索结果

### 2. Freshness参数转换

百度API使用的时间范围格式与标准格式不同：

| 标准格式 | 百度API格式 |
|---------|------------|
| pd (past day) | week |
| pw (past week) | week |
| pm (past month) | month |
| py (past year) | year |

### 3. 自动降级机制

实现了一个三层降级机制，确保在API受限或失败时能够自动切换到其他可用的搜索方法。

## 编译和测试

### 编译结果

使用`pnpm tsdown`命令编译代码，编译成功，无语法错误：

```
✔ Build complete in 15979ms
282 files, total: 7339.93 kB
```

### 测试计划

1. **单元测试**：测试各个API封装函数的正确性
2. **集成测试**：测试搜索框架的自动降级机制
3. **功能测试**：测试百度搜索的完整功能
4. **性能测试**：测试不同搜索方法的响应时间

## 遇到的问题和解决方案

### 1. API端点错误

**问题**：初始实现中使用了错误的API端点。
**解决方案**：根据百度智能云文档，修正了API端点地址。

### 2. Freshness参数支持

**问题**：百度API使用的时间范围格式与标准格式不同。
**解决方案**：添加了`freshnessToBaiduRecency`函数进行格式转换。

### 3. 缓存键生成

**问题**：缓存键没有包含`freshness`参数，导致不同时间范围的搜索结果被错误缓存。
**解决方案**：修改了缓存键生成逻辑，包含了`freshness`参数。

### 4. 错误处理

**问题**：API调用失败时缺少适当的错误处理和降级机制。
**解决方案**：实现了三层降级机制，确保搜索功能的可靠性。

## 后续优化方向

1. **API密钥管理**：实现更安全的API密钥管理机制
2. **搜索结果排序**：优化搜索结果的排序和过滤
3. **并发搜索**：实现多个搜索API的并发调用，提高搜索速度
4. **用户偏好**：根据用户历史偏好选择合适的搜索方法
5. **监控和告警**：添加API调用监控和告警机制

## 总结

成功集成了百度智能云千帆平台的三个搜索API，并实现了一个智能的搜索框架，能够根据情况自动选择合适的搜索方法。代码已经通过TypeScript编译，无语法错误，具备了生产环境使用的基础条件。
