# Notice

Laya Memory (layaForMemory) is an unofficial project built on a browser port of the Laya typed-decisions checkpoint. It is not affiliated with or endorsed by ConvAI Innovations, TypeSafe, the authors of `invalidate`, Microsoft, Hugging Face, Answer.AI, LightOn or the sentence-transformers authors.

## This project

The invalidation policy, memory store, event tracker, evaluation harness, pages and sample cases in this repository are Copyright 2026 vishalmysore and licensed under the Apache License, Version 2.0 (see `LICENSE`).

The design (typed yes/no votes per memory and event, a fixed policy over the votes, memory text never edited, an audit ledger written before any change, a review queue instead of guessing) follows the ideas described in [chopratejas/invalidate](https://github.com/chopratejas/invalidate) (Apache-2.0). No code from that project is included; this is an independent JavaScript implementation that runs a different model (Laya) in the browser.

`web/cases.json` was written for this demo. People, teams and products in it are fictional. `web/recorded.json` holds votes the same model produced for those cases and the built-in scenarios, so the pages can show them before anything is downloaded.

## The models (downloaded at runtime, not part of this repository)

- **Judge:** [`VishalMysore/layaForWebTrained`](https://huggingface.co/VishalMysore/layaForWebTrained), a modified derivative of [`convaiinnovations/laya-typed-decisions`](https://huggingface.co/convaiinnovations/laya-typed-decisions) (Copyright ConvAI Innovations, Apache-2.0), exported to ONNX and quantized by the [layaForWeb](https://github.com/vishalmysore/layaForWeb) project. Laya is built on ModernBERT-large by Answer.AI and LightOn (Apache-2.0).
- **Retriever:** [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (Apache-2.0), the ONNX export of [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) (Apache-2.0).

`web/laya-core.js` and `web/model.js` are copied from layaForWeb / layaForWorkflows, and `web/embedder.js` from layaAsRagJudge. `laya-core.js` is a JavaScript port of the Python `laya/common.py` (`build_sequence`) and `laya/agent.py` (`system_one`) from https://github.com/NandhaKishorM/laya (Apache-2.0).

## Third-party software shipped with the page (`vendor/`)

- **ONNX Runtime Web** (`onnxruntime-web` 1.30.0): Copyright (c) Microsoft Corporation, MIT License. `licenses/onnxruntime-LICENSE.txt`; notices for components inside the WebAssembly binary are in `licenses/onnxruntime-ThirdPartyNotices.txt`.
- **Tokenizers.js** (`@huggingface/tokenizers` 0.2.0): Hugging Face, Apache License 2.0. `licenses/tokenizers.js-LICENSE.txt`.
