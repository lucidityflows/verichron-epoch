#!/usr/bin/env python3
import json
import requests

OLLAMA_URL = "http://localhost:11434/api/generate"
MODELS = ["qwen2.5:3b-instruct", "llama3:8b-instruct-q4_K_M"]

# Your exact constraints
SYSTEM_PROMPT = (
    "You are an expert iOS digital forensics analyst. Analyze this small chunk of MVT JSON logs.\n"
    "You will be provided with the JSON context/schema keys to help you interpret the values accurately.\n"
    "Look ONLY for indicators of compromise, unrecognized background daemons, or suspicious network traffic.\n\n"
    "CRITICAL FORMATTING RULES:\n"
    "1. If you find anomalies, output them ONLY as markdown table rows using this exact format:\n"
    "   | Timestamp | Process / Domain / Artifact | Risk Level | Brief Technical Justification |\n"
    "2. Do NOT include markdown table headers (no '| --- |') or introduction text. Just provide the raw rows.\n"
    "3. If everything in this chunk looks completely normal and safe, reply ONLY with the word: SAFE."
)

SCHEMA_KEYS = ["timestamp", "process", "network_dest", "status"]

# A synthetic chunk containing normal Apple background noise and one highly suspicious beacon
MOCK_CHUNK = """[
  {"timestamp": "2026-05-28T02:14:00Z", "process": "dasd", "status": "background_activity"},
  {"timestamp": "2026-05-28T03:00:15Z", "process": "com.apple.WebKit.Networking", "status": "active"},
  {"timestamp": "2026-05-28T03:01:00Z", "process": "pwned_sys_updater", "network_dest": "103.45.67.89", "status": "running"}
]"""

def run_benchmark():
    print("Starting Forensics Benchmark (Speed & Accuracy)...\n")

    for model in MODELS:
        print(f"========================================")
        print(f"🧪 Testing Model: {model}")
        print(f"========================================")

        # Wake/Load the model into VRAM first so we don't benchmark disk-read time
        requests.post(OLLAMA_URL, json={"model": model, "prompt": "wake up", "stream": False})

        prompt = f"DATABASE SCHEMA FIELDS FOR REFERENCE: {SCHEMA_KEYS}\n\n{SYSTEM_PROMPT}\n\nLOG DATA CHUNK:\n{MOCK_CHUNK}"
        payload = {"model": model, "prompt": prompt, "stream": False}

        try:
            resp = requests.post(OLLAMA_URL, json=payload).json()

            # Ollama returns timings in nanoseconds, convert to seconds
            prompt_eval_sec = resp.get("prompt_eval_duration", 1) / 1e9
            eval_sec = resp.get("eval_duration", 1) / 1e9

            # Calculate Tokens Per Second (TPS)
            prompt_tps = resp.get("prompt_eval_count", 0) / prompt_eval_sec if prompt_eval_sec > 0 else 0
            gen_tps = resp.get("eval_count", 0) / eval_sec if eval_sec > 0 else 0

            result_text = resp.get("response", "").strip()

            # Grade Formatting: Did it leak the markdown headers?
            has_headers = "timestamp" in result_text.lower() and "risk level" in result_text.lower()

            # Grade Accuracy: Did it catch the synthetic threat?
            caught_anomaly = "pwned" in result_text.lower() or "103.45.67.89" in result_text

            print(f"🚀 Prompt Processing (Input):  {prompt_tps:.1f} tokens/sec")
            print(f"⚡ Generation Speed (Output): {gen_tps:.1f} tokens/sec")
            print(f"✅ Format Compliant:          {'No (Failed negative constraints)' if has_headers else 'Yes'}")
            print(f"🎯 Caught the Anomaly:        {'Yes' if caught_anomaly else 'No (Missed Threat)'}")
            print(f"\nRaw Model Output:\n{result_text}\n")

        except Exception as e:
            print(f"Failed to test {model}: Is it installed? Error: {e}\n")

if __name__ == "__main__":
    run_benchmark()
