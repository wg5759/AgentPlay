// 本文件由 scripts/package-whisper-pack.mjs 生成，请勿手改。
// 组件包托管在 GitHub Release 的 whisper-pack-v1 标签；SHA-256 与发布资产一一对应。
module.exports = {
  "schemaVersion": 1,
  "tag": "whisper-pack-v1",
  "product": "AgentPlay 录音转写组件（whisper.cpp + ggml-tiny）",
  "assets": [
    {
      "id": "model-ggml-tiny",
      "kind": "file",
      "label": "ggml-tiny 模型",
      "path": "ggml-tiny.bin",
      "role": "model",
      "url": "https://github.com/wg5759/AgentPlay/releases/download/whisper-pack-v1/ggml-tiny.bin",
      "size": 77691713,
      "sha256": "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"
    },
    {
      "id": "whisper-engine-win-x64",
      "kind": "zip",
      "label": "whisper.cpp 引擎",
      "url": "https://github.com/wg5759/AgentPlay/releases/download/whisper-pack-v1/whisper-bin-x64.zip",
      "size": 3968674,
      "sha256": "d824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d",
      "files": [
        {
          "path": "engine/bench.exe",
          "size": 28160,
          "sha256": "b4ca25878ab5df1d02b9dcf31dfa2a00e42cf6ad0c8cb786ee5d4d2d3778f887"
        },
        {
          "path": "engine/command.exe",
          "size": 28160,
          "sha256": "610513ea5ac370312cb8b602c84de6e15a8341f3f3349cdee7388abf01ce1497"
        },
        {
          "path": "engine/ggml-base.dll",
          "size": 536064,
          "sha256": "61c9c57f49f380896ed54ed3f71735e10a2d986f482c2b0a55e72b47f731b193"
        },
        {
          "path": "engine/ggml-cpu.dll",
          "size": 683008,
          "sha256": "eb2f1d023e51c40b27463b5ab165600eb48cb60323740f400b1b62e1c8706c56"
        },
        {
          "path": "engine/ggml.dll",
          "size": 67584,
          "sha256": "bcfeaf6e5b59c315fc36e290715aa7a84b22461e968543c13dfcf57df7b1b81d"
        },
        {
          "path": "engine/main.exe",
          "size": 28160,
          "sha256": "902ee1ca8c43630344ec1c8cb660b909a93688b094ebc09003b2b2261ccd0f8d"
        },
        {
          "path": "engine/SDL2.dll",
          "size": 2500096,
          "sha256": "de23db1694a3c7a4a735e7ecd3d214b2023cc2267922c6c35d30c7fc7370d677"
        },
        {
          "path": "engine/stream.exe",
          "size": 28160,
          "sha256": "f69a3963ec94a3831c10cba2e70331869f59f09e1e7035e7538c162bc028fa5b"
        },
        {
          "path": "engine/test-vad-full.exe",
          "size": 363520,
          "sha256": "0d73641a18abfb502c41b3e4fe45ff1c501b94ba0f430f19bbecd0a03fe1e829"
        },
        {
          "path": "engine/test-vad.exe",
          "size": 363520,
          "sha256": "6941acd56568d9573701178c0e16219aa03dce05827bb13f22a42158cc3b5582"
        },
        {
          "path": "engine/wchess.exe",
          "size": 165376,
          "sha256": "15184567a322ddd1dea0ffac6451bbca37a79d3c0f3d9af15b701a771b1bb513"
        },
        {
          "path": "engine/whisper-bench.exe",
          "size": 20992,
          "sha256": "96c9853fb7a26e246fa9daf2884379d5a0788e5e2da318ff9c68df40b99a5ae8"
        },
        {
          "path": "engine/whisper-cli.exe",
          "size": 480768,
          "sha256": "0ff971e410240a0b97117432d771245698f376e06105c011959d2bfc4bb23311"
        },
        {
          "path": "engine/whisper-command.exe",
          "size": 168960,
          "sha256": "4557afc4d0d8e96262b77f257e26f4daf75b64033eec7ae8492946f07e0fe7c2"
        },
        {
          "path": "engine/whisper-lsp.exe",
          "size": 180736,
          "sha256": "7e0dfc2543605edfcdff922a9de8310436381340009adb76c4d287e8e47477a7"
        },
        {
          "path": "engine/whisper-quantize.exe",
          "size": 103936,
          "sha256": "495b041555e405bf70d383671a50d4c62e01c64c99c894d1e174b6938334c112"
        },
        {
          "path": "engine/whisper-server.exe",
          "size": 720896,
          "sha256": "65b8779a4944b03ab25fb3a288d534ef20b4b9802fc18beb43c4e17286631136"
        },
        {
          "path": "engine/whisper-stream.exe",
          "size": 387072,
          "sha256": "b31d4da1681a97b7241876537523e44df331e09228fcc409d4e9446e18fb7fa2"
        },
        {
          "path": "engine/whisper-talk-llama.exe",
          "size": 2233856,
          "sha256": "85cf54babee1790b4668820bd143748c6617567c279cccdd15b8d03ba8164052"
        },
        {
          "path": "engine/whisper-vad-speech-segments.exe",
          "size": 371200,
          "sha256": "b56d440d74eb61b7cc84faf6350d2407ef089722fb04fe2c047f6cc06dd78e8c"
        },
        {
          "path": "engine/whisper.dll",
          "size": 483840,
          "sha256": "4037a6567fbb08fc7efda18e4d128a95df9c31ba171af20439d1a93b785d007e"
        }
      ]
    }
  ]
}
