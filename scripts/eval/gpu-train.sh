#!/bin/bash
# On the GPU VM: bash gpu-train.sh setup | train | merge | gguf. Files live in ~/train (chats.jsonl, train.py next to this script).
# train runs under nohup and touches /run/gpu-active while it runs, so the VM's idle power-off leaves it alone.
set -eu
cd ~/train
BASE=Qwen/Qwen2.5-Coder-7B-Instruct
awake() { nohup bash -c "while kill -0 $1 2>/dev/null; do sudo touch /run/gpu-active; sleep 60; done" >/dev/null 2>&1 & }
case "${1:-}" in
setup)
  awake $$
  # The boot-time unattended upgrade holds the apt lock for a few minutes.
  sudo apt-get -o DPkg::Lock::Timeout=900 update -qq && sudo apt-get -o DPkg::Lock::Timeout=900 install -y -qq python3-pip python3-venv
  [ -d venv ] || python3 -m venv venv
  . venv/bin/activate
  pip install -q torch transformers peft trl bitsandbytes accelerate datasets huggingface_hub
  python -c "from huggingface_hub import snapshot_download; snapshot_download('$BASE', local_dir='base')"
  python -c "import torch; assert torch.cuda.is_available(); print('cuda ok')"
  echo SETUP_DONE
  ;;
train)
  . venv/bin/activate
  nohup python train.py chats.jsonl base out > train.log 2>&1 &
  awake $!
  echo "training pid $!, log ~/train/train.log"
  ;;
merge)
  # Folds out/final into the base weights (fp16 on the GPU) into ./merged, then runs the gguf step.
  # The VM has 15 GB RAM and the fp16 model is ~15 GB: save in small shards, with swap as a safety net.
  [ -f /swapfile ] || { sudo fallocate -l 16G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile; }
  swapon --show | grep -q /swapfile || sudo swapon /swapfile
  . venv/bin/activate
  nohup bash -c "python -c \"
import torch; from transformers import AutoModelForCausalLM, AutoTokenizer; from peft import PeftModel
m = PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained('base', torch_dtype=torch.float16, device_map='cuda'), 'out/final').merge_and_unload()
m.save_pretrained('merged', safe_serialization=True, max_shard_size='1GB'); AutoTokenizer.from_pretrained('out/final').save_pretrained('merged')
\" && bash $0 gguf-run" > merge.log 2>&1 &
  awake $!
  echo "merge pid $!, log ~/train/merge.log"
  ;;
gguf)
  # Ollama 0.40 imports safetensors only through MLX, which has no Qwen2, so convert with llama.cpp to q8_0 GGUF (no compile needed).
  nohup bash $0 gguf-run > gguf.log 2>&1 &
  awake $!
  echo "gguf pid $!, log ~/train/gguf.log"
  ;;
gguf-run)
  . venv/bin/activate
  [ -d llama.cpp ] || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp
  pip install -q -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
  python llama.cpp/convert_hf_to_gguf.py merged --outtype q8_0 --outfile desk-coder.gguf
  printf 'FROM ./desk-coder.gguf\n' > Modelfile
  ollama create desk-coder -f Modelfile
  echo GGUF_DONE
  ;;
*) echo "usage: gpu-train.sh setup|train|merge|gguf" >&2; exit 2 ;;
esac
