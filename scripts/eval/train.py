# QLoRA fine-tune on chats.jsonl (from chats.mjs). Runs on the GPU VM: python train.py <data.jsonl> <base dir> <out dir>
# Resumes from the last checkpoint in <out dir>, so a spot preemption only loses the steps since the last save.
import glob, sys
import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

data, base, out = sys.argv[1:4]
tok = AutoTokenizer.from_pretrained(base)
model = AutoModelForCausalLM.from_pretrained(
    base,
    quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
    torch_dtype=torch.bfloat16,
    device_map="auto",
)
ds = load_dataset("json", data_files=data, split="train").remove_columns(["src"]).shuffle(seed=0)
split = ds.train_test_split(test_size=0.02, seed=0)  # a small held-out slice so eval loss shows overfitting

trainer = SFTTrainer(
    model=model,
    processing_class=tok,
    train_dataset=split["train"],
    eval_dataset=split["test"],
    peft_config=LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM"),
    args=SFTConfig(
        output_dir=out,
        max_length=4096,  # chats.mjs caps examples at 14k chars, about 4k tokens
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_steps=7,  # about 3% of ~230 steps; newer trl dropped warmup_ratio
        num_train_epochs=1,
        bf16=True,
        gradient_checkpointing=True,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=50,
        save_steps=25,
        save_total_limit=2,
        report_to="none",
    ),
)
trainer.train(resume_from_checkpoint=bool(glob.glob(f"{out}/checkpoint-*")))
trainer.save_model(f"{out}/final")
tok.save_pretrained(f"{out}/final")
print("TRAIN_DONE")
