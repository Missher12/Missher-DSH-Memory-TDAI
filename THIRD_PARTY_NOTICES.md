# Third-party notices

## TencentDB Agent Memory

This project is an unofficial DeepSeek Harness integration derived from
**TencentDB Agent Memory**.

- Upstream: https://github.com/TencentCloud/TencentDB-Agent-Memory
- Copyright (C) 2026 Tencent. All rights reserved.
- License: MIT (see the upstream `LICENSE` file).

The L0–L3 memory vocabulary, the host-neutral memory-core idea, and the
extraction prompt contract were studied from upstream. The current MVP is an
independent DSH implementation; it does not yet vendor the upstream core files.
If upstream source is vendored in a later version, the upstream MIT notice and
copyright line must remain in the distributed package.

### Upstream MIT notice

```text
Tencent is pleased to support the open source community by making TencentDB Agent Memory available.

Copyright (C) 2026 Tencent.  All rights reserved.

TencentDB Agent Memory is licensed under the MIT.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other dependencies

- `@node-rs/jieba` — MIT
- `sqlite-vec` — MIT / Apache-2.0 (see package metadata)
- `node:sqlite` — part of Node.js, MIT

## Trademarks

“TencentDB” and “Tencent” are trademarks of Tencent. This project is unofficial
and does not claim affiliation, endorsement, or sponsorship.
