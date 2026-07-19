---
license: apache-2.0
license_link: https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/blob/main/LICENSE
pipeline_tag: text-generation
base_model: Qwen/Qwen3-0.6B
---

# Qwen3-0.6B-GGUF
<a href="https://chat.qwen.ai/" target="_blank" style="margin: 2px;">
    <img alt="Chat" src="https://img.shields.io/badge/%F0%9F%92%9C%EF%B8%8F%20Qwen%20Chat%20-536af5" style="display: inline-block; vertical-align: middle;"/>
</a>

## Qwen3 Highlights

Qwen3 is the latest generation of large language models in Qwen series, offering a comprehensive suite of dense and mixture-of-experts (MoE) models. Built upon extensive training, Qwen3 delivers groundbreaking advancements in reasoning, instruction-following, agent capabilities, and multilingual support, with the following key features:

- **Uniquely support of seamless switching between thinking mode** (for complex logical reasoning, math, and coding) and **non-thinking mode** (for efficient, general-purpose dialogue) **within single model**, ensuring optimal performance across various scenarios.
- **Significantly enhancement in its reasoning capabilities**, surpassing previous QwQ (in thinking mode) and Qwen2.5 instruct models (in non-thinking mode) on mathematics, code generation, and commonsense logical reasoning.
- **Superior human preference alignment**, excelling in creative writing, role-playing, multi-turn dialogues, and instruction following, to deliver a more natural, engaging, and immersive conversational experience.
- **Expertise in agent capabilities**, enabling precise integration with external tools in both thinking and unthinking modes and achieving leading performance among open-source models in complex agent-based tasks.
- **Support of 100+ languages and dialects** with strong capabilities for **multilingual instruction following** and **translation**.


## Model Overview

**Qwen3-0.6B** has the following features:
- Type: Causal Language Models
- Training Stage: Pretraining & Post-training
- Number of Parameters: 0.6B
- Number of Paramaters (Non-Embedding): 0.44B
- Number of Layers: 28
- Number of Attention Heads (GQA): 16 for Q and 8 for KV

- Context Length: 32,768.
- Quantization: q8_0

For more details, including benchmark evaluation, hardware requirements, and inference performance, please refer to our [blog](https://qwenlm.github.io/blog/qwen3/), [GitHub](https://github.com/QwenLM/Qwen3), and [Documentation](https://qwen.readthedocs.io/en/latest/).

## Quickstart

### llama.cpp

Check out our [llama.cpp documentation](https://qwen.readthedocs.io/en/latest/run_locally/llama.cpp.html) for more usage guide.

We advise you to clone [`llama.cpp`](https://github.com/ggerganov/llama.cpp) and install it following the official guide. We follow the latest version of llama.cpp.
In the following demonstration, we assume that you are running commands under the repository `llama.cpp`.

```shell
./llama-cli -hf Qwen/Qwen3-0.6B-GGUF:Q8_0 --jinja --color -ngl 99 -fa -sm row --temp 0.6 --top-k 20 --top-p 0.95 --min-p 0 --presence-penalty 1.5 -c 40960 -n 32768 --no-context-shift
```

### ollama

Check out our [ollama documentation](https://qwen.readthedocs.io/en/latest/run_locally/ollama.html) for more usage guide.

You can run Qwen3 with one command:

```shell
ollama run hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0
```

## Switching Between Thinking and Non-Thinking Mode

You can add `/think` and `/no_think` to user prompts or system messages to switch the model's thinking mode from turn to turn. The model will follow the most recent instruction in multi-turn conversations.

Here is an example of multi-turn conversation:

```
> Who are you /no_think

<think>

</think>

I am Qwen, a large-scale language model developed by Alibaba Cloud. [...]

> How many 'r's are in 'strawberries'? /think

<think>
Okay, let's see. The user is asking how many times the letter 'r' appears in the word "strawberries". [...]
</think>

The word strawberries contains 3 instances of the letter r. [...]
```



## Best Practices

To achieve optimal performance, we recommend the following settings:

1. **Sampling Parameters**:
   - For thinking mode (`enable_thinking=True`), use `Temperature=0.6`, `TopP=0.95`, `TopK=20`, `MinP=0`, and `PresencePenalty=1.5`. **DO NOT use greedy decoding**, as it can lead to performance degradation and endless repetitions.
   - For non-thinking mode (`enable_thinking=False`), we suggest using `Temperature=0.7`, `TopP=0.8`, `TopK=20`, `MinP=0`, and `PresencePenalty=1.5`.
   - **We recommend setting `presence_penalty` to 1.5 for quantized models to suppress repetitive outputs.** You can adjust the `presence_penalty` parameter between 0 and 2. A higher value may occasionally lead to language mixing and a slight reduction in model performance.

2. **Adequate Output Length**: We recommend using an output length of 32,768 tokens for most queries. For benchmarking on highly complex problems, such as those found in math and programming competitions, we suggest setting the max output length to 38,912 tokens. This provides the model with sufficient space to generate detailed and comprehensive responses, thereby enhancing its overall performance.

3. **Standardize Output Format**: We recommend using prompts to standardize model outputs when benchmarking.
   - **Math Problems**: Include "Please reason step by step, and put your final answer within \boxed{}." in the prompt.
   - **Multiple-Choice Questions**: Add the following JSON structure to the prompt to standardize responses: "Please show your choice in the `answer` field with only the choice letter, e.g., `"answer": "C"`."

4. **No Thinking Content in History**: In multi-turn conversations, the historical model output should only include the final output part and does not need to include the thinking content. It is implemented in the provided chat template in Jinja2. However, for frameworks that do not directly use the Jinja2 chat template, it is up to the developers to ensure that the best practice is followed.

### Citation

If you find our work helpful, feel free to give us a cite.

```
@misc{qwen3,
    title  = {Qwen3},
    url    = {https://qwenlm.github.io/blog/qwen3/},
    author = {Qwen Team},
    month  = {April},
    year   = {2025}
}
```
