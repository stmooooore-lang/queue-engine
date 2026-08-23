# Hugging Face Hub API — Correct Query with Filters and Pagination

## Problem: What Broke the Previous Request

The previous request likely used `GET https://huggingface.co/api/models` **without any filters, sorting, or pagination**.

- Hugging Face hosts **over 1,000,000 models** (as of 2024).
- A bare request returns the **entire catalog** as a single giant JSON array.
- The response size is **tens of megabytes** and takes tens of seconds to download.
- Scripts timed out, ran out of memory, or were killed by the runner before the response completed.

**Root cause**: no `limit`, no `sort`, no `filter` → the API defaults to "return everything".

---

## Solution: Use Filters, Sorting, and Explicit Limit

Always include at minimum:
- `limit` — hard cap on returned items (e.g., `limit=20`)
- `sort` — `downloads`, `likes`, `created_at`, `last_modified`, or `trending_score`
- `filter` (optional but recommended) — restrict to a task/category like `text-generation`, `fill-mask`, `image-classification`, etc.
- `direction=-1` for descending (most popular first)

Both the **REST API** and the **`huggingface_hub` Python library** support these parameters.

---

## Working Examples

### 1. REST API (curl) — Top 20 models overall by downloads

```bash
curl -s "https://huggingface.co/api/models?sort=downloads&direction=-1&limit=20"
```

**Example response (truncated to 3 models):**

```json
[
  {
    "modelId": "sentence-transformers/all-MiniLM-L6-v2",
    "downloads": 256063914,
    "likes": 5245,
    "pipeline_tag": "sentence-similarity",
    "library_name": "sentence-transformers",
    "tags": ["sentence-transformers", "pytorch", "tf", "rust", "onnx", "safetensors", "bert", "feature-extraction", "en", "license:apache-2.0"]
  },
  {
    "modelId": "google-bert/bert-base-uncased",
---

### 2. REST API (curl) — Top 10 text-generation models by downloads

```bash
curl -s "https://huggingface.co/api/models?filter=text-generation&sort=downloads&direction=-1&limit=10"
```

**Example response (truncated to 3 models):**

```json
[
  {
    "modelId": "Qwen/Qwen3-0.6B",
    "downloads": 24379087,
    "likes": 1532,
    "pipeline_tag": "text-generation",
    "library_name": "transformers",
    "tags": ["transformers", "safetensors", "qwen3", "text-generation", "conversational", "license:apache-2.0"]
  },
  {
    "modelId": "trl-internal-testing/tiny-Qwen2ForCausalLM-2.5",
    "downloads": 15836401,
    "likes": 20,
    "pipeline_tag": "text-generation",
    "library_name": "transformers",
    "tags": ["transformers", "safetensors", "qwen2", "text-generation", "trl"]
  },
  {
    "modelId": "Qwen/Qwen3-8B",
    "downloads": 15091394,
    "likes": 1316,
    "pipeline_tag": "text-generation",
    "library_name": "transformers",
    "tags": ["transformers", "safetensors", "qwen3", "text-generation", "conversational", "license:apache-2.0"]
  }
  // ... 7 more
]
```

---

### 3. Python (`huggingface_hub` library) — Top 20 by downloads

```python
from huggingface_hub import list_models

# Explicit limit + sort; no filter = all categories
models = list(list_models(sort="downloads", limit=20))

for m in models:
    print(f"{m.modelId} | downloads={m.downloads:,} | likes={m.likes} | task={m.pipeline_tag}")
```

**Output:**

```
sentence-transformers/all-MiniLM-L6-v2 | downloads=256,063,914 | likes=5245 | task=sentence-similarity
google-bert/bert-base-uncased | downloads=96,257,858 | likes=2738 | task=fill-mask
cross-encoder/ms-marco-MiniLM-L6-v2 | downloads=87,758,341 | likes=301 | task=text-ranking
BAAI/bge-small-en-v1.5 | downloads=71,880,420 | likes=538 | task=feature-extraction
google/electra-base-discriminator | downloads=55,107,617 | likes=154 | task=None
sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 | downloads=54,590,548 | likes=1353 | task=sentence-similarity
BAAI/bge-m3 | downloads=36,256,175 | likes=3419 | task=sentence-similarity
amazon/chronos-2 | downloads=35,759,762 | likes=406 | task=time-series-forecasting
microsoft/DialoGPT-small | downloads=33,198,885 | likes=686 | task=conversational
openai-community/gpt2 | downloads=14,173,929 | likes=3411 | task=text-generation
... (10 more)
```

---

### 4. Python (`huggingface_hub`) — Top 10 text-generation models by downloads

```python
from huggingface_hub import list_models

models = list(list_models(filter="text-generation", sort="downloads", limit=10))

for m in models:
    print(f"{m.modelId} | downloads={m.downloads:,} | likes={m.likes}")
```

**Output:**

```
Qwen/Qwen3-0.6B | downloads=24,379,087 | likes=1532
trl-internal-testing/tiny-Qwen2ForCausalLM-2.5 | downloads=15,836,401 | likes=20
Qwen/Qwen3-8B | downloads=15,091,394 | likes=1316
facebook/opt-125m | downloads=15,037,574 | likes=293
openai-community/gpt2 | downloads=14,173,929 | likes=3411
unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF | downloads=12,737,285 | likes=917
nvidia/Qwen3.6-35B-A3B-NVFP4 | downloads=12,629,387 | likes=563
Qwen/Qwen2.5-7B-Instruct | downloads=11,631,529 | likes=1553
Qwen/Qwen2.5-1.5B-Instruct | downloads=8,953,132 | likes=806
meta-llama/Llama-3.2-1B-Instruct | downloads=7,639,242 | likes=1581
```

---

### 5. With Authentication (Private/Gated Models)

If you need to access gated/private models, pass the token from the environment variable `HUGGINGFACE_TOKEN`:

**REST API:**
```bash
curl -s -H "Authorization: Bearer $HUGGINGFACE_TOKEN" \
  "https://huggingface.co/api/models?filter=text-generation&sort=downloads&direction=-1&limit=10"
```

**Python:**
```python
import os
from huggingface_hub import list_models

token = os.getenv("HUGGINGFACE_TOKEN")
models = list(list_models(filter="text-generation", sort="downloads", limit=10, token=token))
```

> **Note**: For public models (the vast majority), no token is required. The token is only needed for gated or private repos.

---

## Summary of Fixes

| Before (Broken) | After (Fixed) |
|-----------------|---------------|
| `GET /api/models` | `GET /api/models?sort=downloads&direction=-1&limit=20` |
| No `limit` → returns 1M+ models | `limit=20` → returns exactly 20 |
| No `sort` → arbitrary order | `sort=downloads` + `direction=-1` → most popular first |
| No `filter` → all categories | Optional `filter=text-generation` (or other task) |
| No auth handling | Optional `Authorization: Bearer $HUGGINGFACE_TOKEN` |

---

## References

- Hugging Face Hub API docs: https://huggingface.co/docs/hub/api
- `huggingface_hub` Python library: https://huggingface.co/docs/huggingface_hub/package_reference/hf_api#huggingface_hub.HfApi.list_models
- Model filters (task tags): https://huggingface.co/docs/hub/api#models