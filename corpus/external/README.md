# 外刊发布源

网站端只读 `current/articles.jsonl`，默认目录为：

```text
corpus/external/current/
├── articles.jsonl
└── manifest.json
```

也可以通过 `config.kb.externalDir` 或环境变量 `EXTERNAL_CORPUS_DIR` 指向本地验收后的发布目录。`current/` 和 `releases/` 属于运行时数据，已加入 `.gitignore`，不随网站代码提交。

每行文章至少需要：

```json
{
  "schema_version": 1,
  "id": "art_<stable-hash>",
  "rtype": "article",
  "title": "Article title",
  "source": {
    "publication": "The Guardian",
    "canonical_url": "https://example.com/article",
    "published_at": "2026-09-09",
    "section": "Science"
  },
  "paragraphs": ["Full paragraph"],
  "sentences": [],
  "vocab_analysis": {},
  "quality": {"status": "accepted"}
}
```

网站会兼容 `text`、`paragraphs` 和 `content.paragraphs` 三种正文形态，并补齐 `category: 外刊` 与年份。外刊在网站端不可编辑和删除，修改必须回到采集或本地验收层。

`manifest.json` 可提供 `release_id`、`generated_at`、`article_count` 和 `schema_version`，用于 `/api/kb/status` 的发布核对。
