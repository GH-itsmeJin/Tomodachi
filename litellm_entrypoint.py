import json
import os
import shutil
from pathlib import Path


def build_config(keys, provider_model, master_key):
    model_entries = []
    for index, key in enumerate(keys, start=1):
        model_name = "tomodachi" if index == 1 else f"tomodachi-key_{index}"
        model_entries.extend([
            f"  - model_name: {model_name}",
            "    litellm_params:",
            f"      model: {json.dumps(provider_model)}",
            f"      api_key: {json.dumps(key)}",
            "      timeout: 30",
            "    model_info:",
            f"      id: key_{index}",
        ])

    config = "\n".join([
        "model_list:",
        *model_entries,
        "",
        "router_settings:",
        "  num_retries: 0",
        "",
        "litellm_settings:",
        "  cache: true",
        "  cache_params:",
        "    type: local",
        "",
        "general_settings:",
        f"  master_key: {json.dumps(master_key)}",
        "",
    ])
    return config


def main():
    keys = [key.strip() for key in os.environ.get("OPENAI_API_KEYS", "").split(",") if key.strip()]
    if len(keys) < 2:
        raise SystemExit("OPENAI_API_KEYS must contain at least two comma-separated provider keys.")

    provider_model = os.environ.get("LITELLM_PROVIDER_MODEL", "openai/gpt-4o-mini")
    config = build_config(keys, provider_model, os.environ.get("LITELLM_MASTER_KEY", ""))
    config_path = Path(os.environ.get("LITELLM_CONFIG_PATH", "/tmp/tomodachi-litellm.yaml"))
    config_path.write_text(config, encoding="utf-8")

    executable = shutil.which("litellm")
    if not executable:
        raise SystemExit("LiteLLM executable was not found in the gateway image.")
    port = os.environ.get("LITELLM_PORT", "4000")
    os.execv(executable, [executable, "--config", str(config_path), "--port", port])


if __name__ == "__main__":
    main()
