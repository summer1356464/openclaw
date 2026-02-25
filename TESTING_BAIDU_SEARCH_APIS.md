# 百度搜索API测试指南

本指南将说明如何通过OpenClaw的agent message命令测试不同的百度搜索API。

## 实现概述

已经在web-search.ts文件中实现了`baiduSearchType`参数，允许用户指定要使用的百度搜索API类型：

1. **智能搜索生成（高性能版）** - `intelligent`
2. **智能搜索生成** - `chat_completions`
3. **百度搜索** - `web_search`

## 测试方法

### 通过Agent Message命令测试

使用`openclaw message --agent`命令发送包含`web_search`工具调用的消息，在参数中指定`baiduSearchType`来选择不同的API：

#### 1. 测试智能搜索生成（高性能版）

```bash
openclaw message --agent "{
  \"tool_calls\": [
    {
      \"function\": {
        \"name\": \"web_search\",
        \"parameters\": {
          \"query\": \"最新人工智能技术趋势\",
          \"count\": 5,
          \"baiduSearchType\": \"intelligent\"
        }
      }
    }
  ]
}"
```

#### 2. 测试智能搜索生成

```bash
openclaw message --agent "{
  \"tool_calls\": [
    {
      \"function\": {
        \"name\": \"web_search\",
        \"parameters\": {
          \"query\": \"最新人工智能技术趋势\",
          \"count\": 5,
          \"baiduSearchType\": \"chat_completions\"
        }
      }
    }
  ]
}"
```

#### 3. 测试百度搜索

```bash
openclaw message --agent "{
  \"tool_calls\": [
    {
      \"function\": {
        \"name\": \"web_search\",
        \"parameters\": {
          \"query\": \"最新人工智能技术趋势\",
          \"count\": 5,
          \"baiduSearchType\": \"web_search\"
        }
      }
    }
  ]
}"
```

### 自动降级机制

如果不指定`baiduSearchType`参数，系统会自动使用降级机制：
1. 首先尝试使用智能搜索生成（高性能版）
2. 如果失败，尝试使用智能搜索生成
3. 如果失败，尝试使用百度搜索
4. 如果所有API都失败，使用网页抓取作为回退方案

## 验证方法

在搜索结果中，会包含`searchType`字段，显示实际使用的搜索API类型：

```json
{
  "query": "最新人工智能技术趋势",
  "provider": "baidu",
  "searchType": "intelligent",  // 这里显示实际使用的API类型
  "count": 5,
  "tookMs": 1234,
  "results": [...]
}
```

## 错误处理

如果指定了无效的`baiduSearchType`值，系统会返回错误信息：

```json
{
  "error": "invalid_baidu_search_type",
  "message": "baiduSearchType must be one of: intelligent, chat_completions, web_search",
  "docs": "https://docs.openclaw.ai/tools/web"
}
```

## 缓存机制

系统会为不同的搜索类型生成不同的缓存键，确保不同API的结果不会相互混淆。

## 性能考虑

- **智能搜索生成（高性能版）** - 响应速度最快，但可能有额度限制
- **智能搜索生成** - 响应速度较快，功能完整
- **百度搜索** - 响应速度较慢，但结果更全面

## 测试建议

1. 首先测试智能搜索生成（高性能版），确认其工作正常
2. 然后测试其他两个API，确保它们也能正常工作
3. 最后测试自动降级机制，确认当首选API失败时能够正确降级

## 环境配置

确保已设置`BAIDU_API_KEY`环境变量，或在配置文件中指定百度API密钥：

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "baidu",
        "apiKey": "your-baidu-api-key"
      }
    }
  }
}
```

## 故障排除

如果遇到问题，请检查：
1. 百度API密钥是否正确设置
2. 网络连接是否正常
3. 百度API服务是否可用
4. 搜索参数是否正确格式

通过以上方法，您可以方便地测试和使用所有三个百度搜索API。
