#!/bin/bash
# On the GPU VM: bash gpu-train.sh setup | train | merge | gguf, or all (every step) and status. Files live in ~/train (chats.jsonl, train.py next to this script).
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
  # Folds out/final into the base weights into ./merged, then runs the gguf step.
  nohup bash -c "bash $0 merge-run && bash $0 gguf-run" > merge.log 2>&1 &
  awake $!
  echo "merge pid $!, log ~/train/merge.log"
  ;;
merge-run)
  # fp16 on the GPU. The VM has 15 GB RAM and the fp16 model is ~15 GB: save in small shards, with swap as a safety net.
  [ -f /swapfile ] || { sudo fallocate -l 16G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile; }
  swapon --show | grep -q /swapfile || sudo swapon /swapfile
  . venv/bin/activate
  python -c "
import torch; from transformers import AutoModelForCausalLM, AutoTokenizer; from peft import PeftModel
m = PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained('base', torch_dtype=torch.float16, device_map='cuda'), 'out/final').merge_and_unload()
m.save_pretrained('merged', safe_serialization=True, max_shard_size='1GB'); AutoTokenizer.from_pretrained('out/final').save_pretrained('merged')
"
  touch merged/.done
  ;;
gguf)
  # Ollama 0.40 imports safetensors only through MLX, which has no Qwen2, so convert with llama.cpp to q8_0 GGUF (no compile needed).
  nohup bash $0 gguf-run > gguf.log 2>&1 &
  awake $!
  echo "gguf pid $!, log ~/train/gguf.log"
  ;;
gguf-run)
  # Own venv: the converter pins an old transformers and a CPU torch, which would break the training venv.
  [ -d gguf-venv ] || python3 -m venv gguf-venv
  . gguf-venv/bin/activate
  [ -d llama.cpp ] || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp
  pip install -q -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
  # Training leaves the tokenizer unchanged; the base's files are readable by the converter's older transformers.
  cp base/tokenizer.json base/tokenizer_config.json base/vocab.json base/merges.txt merged/
  python llama.cpp/convert_hf_to_gguf.py merged --outtype q8_0 --outfile desk-coder.gguf
  printf 'FROM ./desk-coder.gguf\n' > Modelfile
  ollama create desk-coder -f Modelfile
  echo GGUF_DONE
  ;;
all)
  # What the app's "Train your own model" runs: every step in order, in the background, into all.log.
  # Running it again after a preemption resumes; new chats.jsonl data starts the training over.
  if [ -f all.pid ] && kill -0 "$(cat all.pid)" 2>/dev/null; then echo "already running"; exit 0; fi
  nohup bash $0 all-run > all.log 2>&1 &
  echo $! > all.pid
  awake $!
  echo "pipeline pid $!, log ~/train/all.log"
  ;;
all-run)
  sum=$(sha256sum chats.jsonl | cut -c1-64)
  [ "$(cat out/.data 2>/dev/null)" = "$sum" ] || rm -rf out merged
  mkdir -p out && echo "$sum" > out/.data
  echo "STAGE setup"; bash $0 setup
  echo "STAGE train"; . venv/bin/activate; [ -d out/final ] || python train.py chats.jsonl base out
  echo "STAGE merge"; [ -f merged/.done ] || bash $0 merge-run
  echo "STAGE convert"; bash $0 gguf-run
  echo "STAGE done"
  ;;
status)
  # One line for the app: running|stopped, then the last stage and log line.
  if [ -f all.pid ] && kill -0 "$(cat all.pid)" 2>/dev/null; then echo running; else echo stopped; fi
  grep '^STAGE ' all.log 2>/dev/null | tail -n 1
  tail -c 2000 all.log 2>/dev/null | tr '\r' '\n' | grep -v '^\s*$' | tail -n 1
  ;;
*) echo "usage: gpu-train.sh setup|train|merge|gguf|all|status" >&2; exit 2 ;;
esac
