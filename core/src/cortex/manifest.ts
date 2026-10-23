// Pinned manifest of downloadable local-AI components.
// Every URL, size and SHA-256 below was read from the publisher's own API by the
// "Discover runtime and model facts" CI job (.github/workflows/discover.yml) — none are invented.
// To update: run that workflow and copy its output here.

export interface RuntimeBuild {
  id: string;
  version: string; // llama.cpp build tag
  platform: "win32" | "linux";
  arch: "x64";
  variant: "cpu" | "vulkan";
  url: string;
  size: number;
  sha256: string;
  archive: "zip" | "tar.gz";
  license: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  family: string;
  parameters: string;
  quantization: string;
  url: string;
  source: string; // human-readable source page
  file: string;
  size: number;
  sha256: string;
  license: string;
  licenseUrl: string;
  contextLength: number;
  minRamGb: number; // conservative system RAM needed to run comfortably on CPU
  notes: string;
}

const LLAMA_TAG = "b11829";
const rel = (name: string) => `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${name}`;

export const RUNTIMES: RuntimeBuild[] = [
  { id: `llama.cpp-${LLAMA_TAG}-win-cpu-x64`, version: LLAMA_TAG, platform: "win32", arch: "x64", variant: "cpu", url: rel(`llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`), size: 24076171, sha256: "c534f35ce9c842f3bc224fadaecc82e1b49768f63e8320922f6dbd603f66395e", archive: "zip", license: "MIT" },
  { id: `llama.cpp-${LLAMA_TAG}-win-vulkan-x64`, version: LLAMA_TAG, platform: "win32", arch: "x64", variant: "vulkan", url: rel(`llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`), size: 36876542, sha256: "839ff55ce9cbee6a099b403b640ca6b694ee5d74b815e39f77fc5d2b20962f0d", archive: "zip", license: "MIT" },
  { id: `llama.cpp-${LLAMA_TAG}-ubuntu-x64`, version: LLAMA_TAG, platform: "linux", arch: "x64", variant: "cpu", url: rel(`llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`), size: 22346390, sha256: "281df0193466d75022958c331697ba3d702bbecb62c5c82e09178facbc851f5c", archive: "tar.gz", license: "MIT" },
  { id: `llama.cpp-${LLAMA_TAG}-ubuntu-vulkan-x64`, version: LLAMA_TAG, platform: "linux", arch: "x64", variant: "vulkan", url: rel(`llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`), size: 34989558, sha256: "656bd1425bdde09565f2191c2a62940a1992441497fc5fb5fd45cdfa337e621f", archive: "tar.gz", license: "MIT" },
];

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;

export const MODELS: ModelEntry[] = [
  {
    id: "qwen2.5-0.5b-instruct-q4_k_m",
    name: "Qwen2.5 0.5B Instruct",
    family: "Qwen2.5",
    parameters: "0.5B",
    quantization: "Q4_K_M",
    url: hf("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
    source: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    size: 491400032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    contextLength: 32768,
    minRamGb: 3,
    notes: "Smallest and fastest. Good for simple facts; weaker at subtle comparisons.",
  },
  {
    id: "qwen2.5-1.5b-instruct-q4_k_m",
    name: "Qwen2.5 1.5B Instruct",
    family: "Qwen2.5",
    parameters: "1.5B",
    quantization: "Q4_K_M",
    url: hf("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    source: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    size: 1117320736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    contextLength: 32768,
    minRamGb: 6,
    notes: "Recommended balance of speed and judgement on most PCs.",
  },
  {
    id: "qwen2.5-3b-instruct-q4_k_m",
    name: "Qwen2.5 3B Instruct",
    family: "Qwen2.5",
    parameters: "3B",
    quantization: "Q4_K_M",
    url: hf("Qwen/Qwen2.5-3B-Instruct-GGUF", "qwen2.5-3b-instruct-q4_k_m.gguf"),
    source: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF",
    file: "qwen2.5-3b-instruct-q4_k_m.gguf",
    size: 2104932768,
    sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
    license: "Qwen Research License (non-commercial; see model page)",
    licenseUrl: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF",
    contextLength: 32768,
    minRamGb: 10,
    notes: "Best judgement of the three, slower on CPU. Its licence is not Apache-2.0: personal use only.",
  },
];

export const DEFAULT_MODEL_ID = "qwen2.5-1.5b-instruct-q4_k_m";

export function findModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

export function runtimeFor(variant: "cpu" | "vulkan", platform = process.platform): RuntimeBuild | undefined {
  return RUNTIMES.find((r) => r.platform === platform && r.variant === variant && r.arch === "x64");
}
