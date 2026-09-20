import json
import sys
import traceback

from mlx_vlm import generate, load


def write_message(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        raise ValueError("AI_MODEL must point to a local MLX model")

    model, processor = load(sys.argv[1])
    write_message({"type": "ready"})
    prompt = (
        "Describe this video frame for private local search. Return JSON only: "
        '{"summary":"short factual description","tags":["searchable","objects","activities"]}. '
        "Do not identify people."
    )

    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            result = generate(
                model,
                processor,
                prompt,
                image=request["image"],
                verbose=False,
                max_tokens=256,
            )
            write_message({"id": request["id"], "ok": True, "text": result.text})
        except Exception as error:
            write_message(
                {
                    "id": request.get("id"),
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                    "traceback": traceback.format_exc(),
                }
            )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"MLX worker failed to start: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
